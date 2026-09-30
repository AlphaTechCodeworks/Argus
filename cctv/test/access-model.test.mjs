// Offline tests for the access editor's model (public/access-model.js): a stored rights row turned
// into ticks over the site -> camera tree, the ticks changed the way the editor changes them, and
// turned back into a row. Temp data folder only (rights.mjs is imported to prove every row the
// editor produces is one it would store unchanged); nothing is sent anywhere, no SDK needed.
//   node cctv/test/access-model.test.mjs
//
// The rules that matter are the ones that decide what a person may see without the admin noticing:
// a site tick means "and every camera added later", unticking one camera must not take the rest of
// the site with it, and a grant the tree cannot show must survive a save instead of vanishing.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-access-model-'))
const R = await import('../rights.mjs')
const M = await import('../public/access-model.js')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const J = (x) => JSON.stringify(x)

// Four NVRs, as /api/sites and /api/cameras answer an admin. 'dark' has not listed its cameras yet
// (an NVR that has been offline since the server started); solus has an empty channel slot.
const SITES = [
  { id: 'solus', site: 'IT Office', name: 'Solus' },
  { id: 'nvr1', site: 'Main site', name: 'NVR 1' },
  { id: 'nvr-2', site: 'NVR 2', name: 'NVR 2' },
  { id: 'dark', site: 'Rigginglot', name: 'Rigginglot' }
]
const cam = (nvr, ch, name, extra = {}) => ({ nvr, ch, name, site: SITES.find((s) => s.id === nvr)?.site, ...extra })
const CAMERAS = [
  cam('nvr1', 2, 'Yard'), cam('nvr1', 0, 'Gate'), cam('nvr1', 1, 'Office'), cam('nvr1', 3, 'Back door'),
  cam('nvr-2', 0, 'Front'), cam('nvr-2', 1, ''),
  cam('solus', 0, 'Desk'), cam('solus', 1, 'Rack'), cam('solus', 2, 'Door'), cam('solus', 3, '', { configured: false })
]
const tree = M.buildTree(SITES, CAMERAS)

// a row as rights.mjs stores it: every grantable action present, sorted
const row = (grants = {}, formats = [], admin = false) => R.cleanRights({ admin, grants, formats })
const grantsOf = (state) => M.toRow(state).grants

// ---- the tree ----------------------------------------------------------------------------------
{
  check('one row per NVR, sorted by site name', J(tree.map((n) => n.nvr)) === J(['solus', 'nvr1', 'nvr-2', 'dark']), J(tree.map((n) => n.nvr)))
  check('each site row carries the site and NVR names', tree[1].site === 'Main site' && tree[1].name === 'NVR 1')
  check('cameras sorted by channel', J(tree[1].cameras.map((c) => c.ch)) === J([0, 1, 2, 3]))
  check('camera names come through', tree[1].cameras[0].name === 'Gate')
  check('a camera with no name is called by its number', tree[2].cameras[1].name === 'Camera 2')
  check('an empty channel slot is not a camera', J(tree[0].cameras.map((c) => c.ch)) === J([0, 1, 2]))
  check('an NVR that has listed no cameras still has its site row', tree[3].nvr === 'dark' && tree[3].cameras.length === 0)
  const orphan = M.buildTree([], [cam('lone', 0, 'Pole')])
  check('a camera whose NVR is not in the site list still gets a site row', orphan.length === 1 && orphan[0].nvr === 'lone' && orphan[0].cameras.length === 1)
  const junk = M.buildTree([{ id: 'a b' }, 7, null, { id: '*' }], [{ nvr: 'x', ch: -1 }, { nvr: 'x', ch: 1.5 }, { nvr: 'x/1', ch: 0 }, { nvr: 'y', ch: 0 }])
  check('junk in, nothing made up out of it', M.buildTree(null, undefined).length === 0 && J(junk.map((n) => [n.nvr, n.cameras.length])) === J([['y', 1]]), J(junk))
  const dup = M.buildTree([{ id: 'n', site: 'S' }], [cam('n', 0, 'A'), cam('n', 0, 'B')])
  check('a channel listed twice is one camera', dup[0].cameras.length === 1)
}

// ---- the same target shapes as rights.mjs --------------------------------------------------------
{
  const samples = ['*', 'nvr1', 'nvr1/3', 'nvr1/007', 'nvr1/', '/3', 'a/b/c', 'nvr1/-1', 'nvr1/1.5', ' nvr1', 'nvr 1', 'x'.repeat(65), 'n:v.r_1-2', 'nvr1/1000', '', null, 7, {}]
  const theirs = (t) => R.cleanRights({ grants: { live: [t] } }).grants.live[0] ?? null
  const disagree = samples.filter((t) => M.cleanTarget(t) !== theirs(t))
  check('cleanTarget accepts and normalises exactly what rights.mjs does', disagree.length === 0, J(disagree))
  check('the grantable actions and formats are the ones rights.mjs knows', J(M.GRANTABLE) === J(R.ACTIONS.filter((a) => a !== 'admin')) && J(M.FORMATS) === J(R.FORMATS))
}

// ---- a row survives the editor untouched ------------------------------------------------------------
{
  const rows = [
    row(),
    row({ live: ['*'], 'playback-nvr': ['*'] }),
    row({ live: ['nvr1', 'solus/1'], 'playback-server': ['nvr-2'], 'playback-nvr': ['nvr1/0'], export: ['nvr1/2'] }, ['mp4']),
    row({ live: ['*', 'nvr1', 'nvr1/2'] }), // redundant but stored: saving must not rewrite it
    row({ live: ['gone', 'nvr1/9', 'dark/4', 'nvr1/0'] }, ['pack', 'stills']),
    row({ live: ['nvr1/0', 'nvr1/1', 'nvr1/2', 'nvr1/3'] }), // every camera, one by one: NOT widened to 'nvr1'
    row({ export: ['*'] }, ['pack', 'mp4', 'stills'], true),
    R.cleanRights({ grants: { live: ['nvr1/007', 'junk target', 42], bogus: ['*'] }, formats: ['mp4', 'exe'], admin: 'true' })
  ]
  const changed = rows.filter((r) => J(M.toRow(M.fromRow(r, tree))) !== J(r))
  check('fromRow then toRow gives back exactly the stored row', changed.length === 0, J(changed))
  check('a row that is not an object becomes nothing, not an error', J(M.toRow(M.fromRow(null, tree))) === J(R.emptyRights()) && J(M.toRow(M.fromRow('x', []))) === J(R.emptyRights()))
  check('the tree may be missing too', J(M.toRow(M.fromRow(rows[2], null))) === J(rows[2]))
}

// ---- '*' ticks everything ----------------------------------------------------------------------
{
  const v = M.view(M.fromRow(row({ live: ['*'] }), tree), tree)
  check("'*' ticks All sites", v.all.live.state === 'on')
  check("'*' ticks every site and every camera", v.sites.every((s) => s.cells.live.state === 'on' && s.cameras.every((c) => c.cells.live.state === 'on')))
  check('...and nothing in the other columns (Live HD, Playback SD, Playback HD, Export)', v.sites.every((s) => ['live-hd', 'playback-nvr', 'playback-server', 'export'].every((c) => s.cells[c].state === 'off')) && ['live-hd', 'playback-nvr', 'playback-server'].every((c) => v.all[c].state === 'off'))
}

// ---- an NVR target ticks the site and its cameras ------------------------------------------------------
{
  const v = M.view(M.fromRow(row({ live: ['nvr1'] }), tree), tree)
  const s = v.sites.find((x) => x.nvr === 'nvr1')
  check('the site is ticked', s.cells.live.state === 'on')
  check('every camera under it is ticked', s.cameras.length === 4 && s.cameras.every((c) => c.cells.live.state === 'on'))
  check('other sites are not', v.sites.filter((x) => x.nvr !== 'nvr1').every((x) => x.cells.live.state === 'off'))
  check('All sites is part-ticked, not ticked', v.all.live.state === 'some')
}

// ---- unticking one camera of a ticked site -----------------------------------------------------------
{
  const st = M.fromRow(row({ live: ['nvr1', 'solus'] }), tree)
  const after = M.toggle(st, tree, 'live', 'nvr1/1', false)
  check('the site becomes the remaining cameras', J(grantsOf(after).live) === J(['nvr1/0', 'nvr1/2', 'nvr1/3', 'solus']), J(grantsOf(after).live))
  const v = M.view(after, tree).sites.find((x) => x.nvr === 'nvr1')
  check('...the site shows part-ticked', v.cells.live.state === 'some')
  check('...the camera shows unticked and the rest ticked', v.cameras.map((c) => c.cells.live.state).join() === 'on,off,on,on')
  check('the state passed in is not changed', J(grantsOf(st).live) === J(['nvr1', 'solus']))
  const single = M.buildTree([{ id: 'one', site: 'One' }], [cam('one', 0, 'Only')])
  check('unticking the only camera of a site leaves nothing on it', J(grantsOf(M.toggle(M.fromRow(row({ live: ['one'] }), single), single, 'live', 'one/0', false)).live) === '[]')
}

// ---- ticking every camera of a site collapses to the site -------------------------------------------------
{
  const st = M.fromRow(row({ live: ['nvr1/0', 'nvr1/1', 'nvr1/2'] }), tree)
  check('three of four is part-ticked', M.view(st, tree).sites.find((x) => x.nvr === 'nvr1').cells.live.state === 'some')
  const after = M.toggle(st, tree, 'live', 'nvr1/3', true)
  check('the fourth makes it the NVR target (so a camera added later is included)', J(grantsOf(after).live) === J(['nvr1']), J(grantsOf(after).live))
  const loaded = M.view(M.fromRow(row({ live: ['nvr1/0', 'nvr1/1', 'nvr1/2', 'nvr1/3'] }), tree), tree).sites.find((x) => x.nvr === 'nvr1')
  check('every camera stored one by one shows part-ticked, and says a new camera is not included', loaded.cells.live.state === 'some' && /later/.test(loaded.cells.live.note), J(loaded.cells.live))
  const single = M.buildTree([{ id: 'one', site: 'One' }], [cam('one', 0, 'Only')])
  check('a site with one camera collapses on that one', J(grantsOf(M.toggle(M.fromRow(row(), single), single, 'live', 'one/0', true)).live) === J(['one']))
  check('ticking a camera already covered changes nothing', J(grantsOf(M.toggle(M.fromRow(row({ live: ['nvr1'] }), tree), tree, 'live', 'nvr1/0', true)).live) === J(['nvr1']))
}

// ---- site rows ---------------------------------------------------------------------------------
{
  const st = M.fromRow(row({ live: ['nvr1/0', 'nvr1/9', 'solus/2'] }), tree)
  const on = M.toggle(st, tree, 'live', 'nvr1', true)
  check('ticking a part-ticked site grants the NVR, and its cameras need no grants of their own', J(grantsOf(on).live) === J(['nvr1', 'solus/2']), J(grantsOf(on).live))
  const off = M.toggle(st, tree, 'live', 'nvr1', false)
  check('unticking a site takes away everything on it, a camera it no longer lists included', J(grantsOf(off).live) === J(['solus/2']), J(grantsOf(off).live))
  const dark = M.toggle(M.fromRow(row(), tree), tree, 'live', 'dark', true)
  check('a site that has listed no cameras can still be ticked', J(grantsOf(dark).live) === J(['dark']))
  check('an unknown site is left alone', J(M.toggle(st, tree, 'live', 'nope', true)) === J(st) && J(M.toggle(st, tree, 'live', 'nvr1/99', true)) === J(st))
  check('an unknown column is left alone', J(M.toggle(st, tree, 'admin', 'nvr1', true)) === J(st))
}

// ---- All sites ------------------------------------------------------------------------------------
{
  const st = M.fromRow(row({ live: ['nvr1/0', 'gone/1', 'nvr-2'] }), tree)
  const all = M.toggle(st, tree, 'live', '*', true)
  check("All sites is '*' alone", J(grantsOf(all).live) === J(['*']))
  const none = M.toggle(all, tree, 'live', '*', false)
  check('unticking All sites leaves nothing in that column', J(grantsOf(none).live) === '[]')
  const star = M.fromRow(row({ live: ['*'] }), tree)
  const minusCam = M.toggle(star, tree, 'live', 'nvr1/2', false)
  check("unticking a camera under '*' keeps every other site whole", J(grantsOf(minusCam).live) === J(['dark', 'nvr-2', 'nvr1/0', 'nvr1/1', 'nvr1/3', 'solus']), J(grantsOf(minusCam).live))
  const minusSite = M.toggle(star, tree, 'live', 'solus', false)
  check("unticking a site under '*' keeps every other site", J(grantsOf(minusSite).live) === J(['dark', 'nvr-2', 'nvr1']), J(grantsOf(minusSite).live))
  const every = M.fromRow(row({ live: ['dark', 'nvr-2', 'nvr1', 'solus'] }), tree)
  check("every site ticked one by one is not widened to '*' (a site added later is not included)", M.view(every, tree).all.live.state === 'some' && J(grantsOf(every).live) === J(['dark', 'nvr-2', 'nvr1', 'solus']))
}

// ---- five columns, one right each; Live HD needs Live ---------------------------------------------------
{
  check('five columns in the owner\'s order, with their full names and meanings', J(M.COLUMNS) === J(['live', 'live-hd', 'playback-nvr', 'playback-server', 'export']) && J(M.COLUMNS.map((c) => M.COLUMN_LABELS[c])) === J(['Live', 'Live HD', 'Playback SD', 'Playback HD', 'Export']) && M.COLUMNS.every((c) => typeof M.COLUMN_TITLES[c] === 'string' && M.COLUMN_TITLES[c].startsWith(M.COLUMN_LABELS[c])))
  check('the columns are every grantable right, once', J([...M.COLUMNS].sort()) === J([...M.GRANTABLE].sort()))
  const [top, sub] = M.HEAD_ROWS
  check('two header rows: Live (Grid, HD), Playback (SD, HD), Export', J(top.map((h) => h.text)) === J(['Site / camera', 'Live', 'Playback', 'Export']) && J(sub.map((h) => [h.text, h.column])) === J([['Grid', 'live'], ['HD', 'live-hd'], ['SD', 'playback-nvr'], ['HD', 'playback-server']]) && top[0].rowspan === 2 && top[0].rowhead === true && top[1].colspan === 2 && top[2].colspan === 2 && top[3].rowspan === 2 && top[3].column === 'export')
  const hdOn = M.toggle(M.fromRow(row({ live: ['nvr1/3'] }), tree), tree, 'live-hd', 'nvr1', true)
  check('ticking Live HD on a site ticks Live there too (HD needs Live)', J(grantsOf(hdOn)['live-hd']) === J(['nvr1']) && J(grantsOf(hdOn).live) === J(['nvr1']), J(grantsOf(hdOn)))
  const hdCam = M.toggle(M.fromRow(row(), tree), tree, 'live-hd', 'solus/1', true)
  check('... on one camera: Live on that camera only', J(grantsOf(hdCam).live) === J(['solus/1']) && J(grantsOf(hdCam)['live-hd']) === J(['solus/1']))
  const hdAll = M.toggle(M.fromRow(row(), tree), tree, 'live-hd', '*', true)
  check("... on All sites: '*' for both", J(grantsOf(hdAll).live) === J(['*']) && J(grantsOf(hdAll)['live-hd']) === J(['*']))
  const liveOff = M.toggle(hdAll, tree, 'live', 'nvr1/0', false)
  const cam0 = M.view(liveOff, tree).sites.find((s) => s.nvr === 'nvr1').cameras[0]
  check('unticking Live on a camera unticks Live HD there too, and nothing else', cam0.cells['live-hd'].state === 'off' && J(grantsOf(liveOff)['live-hd']) === J(grantsOf(liveOff).live), J(grantsOf(liveOff)))
  const hdOff = M.toggle(hdAll, tree, 'live-hd', 'solus', false)
  check('unticking Live HD leaves Live as it was', J(grantsOf(hdOff).live) === J(['*']) && !grantsOf(hdOff)['live-hd'].includes('*'))
  const pbSd = M.toggle(M.fromRow(row(), tree), tree, 'playback-nvr', 'nvr1', true)
  check('Playback SD is the NVR\'s copy alone, Playback HD the server\'s alone', J(grantsOf(pbSd)['playback-nvr']) === J(['nvr1']) && grantsOf(pbSd)['playback-server'].length === 0 && J(grantsOf(M.toggle(pbSd, tree, 'playback-server', 'nvr1', true))['playback-server']) === J(['nvr1']))
  const stray = M.view(M.fromRow(row({ 'live-hd': ['nvr1/2'] }), tree), tree)
  const cam2 = stray.sites.find((s) => s.nvr === 'nvr1').cameras.find((c) => c.ch === 2)
  check('a stored Live HD tick where Live is not: noted "no effect without Live", and warned about', cam2.cells['live-hd'].state === 'on' && /no effect without Live/.test(cam2.cells['live-hd'].note) && stray.warnings.some((w) => /Live HD is ticked where Live is not/.test(w)), J(cam2.cells))
  check('... none of that for Live HD with Live', M.view(hdOn, tree).warnings.length === 0 && M.view(hdOn, tree).sites.find((s) => s.nvr === 'nvr1').cells['live-hd'].note === '')
  check('a column the editor does not have changes nothing', M.toggle(hdOn, tree, 'playback', 'nvr1', true) === hdOn)
}

// ---- a click on a box (what the page calls) ------------------------------------------------------------
{
  const st = M.fromRow(row({ live: ['nvr1/0'], 'playback-nvr': ['solus'] }), tree)
  const v = M.view(st, tree)
  check('cellAt finds All sites, a site and a camera', M.cellAt(v, 'live', '*').state === 'some' && M.cellAt(v, 'live', 'nvr1').state === 'some' && M.cellAt(v, 'live', 'nvr1/0').state === 'on' && M.cellAt(v, 'playback-nvr', 'solus').state === 'on')
  check('cellAt of something not drawn is null', M.cellAt(v, 'live', 'gone') === null && M.cellAt(v, 'nope', 'nvr1') === null && M.cellAt(v, 'live', 'nvr1/9') === null)
  check('a click on a part-ticked site ticks the whole site', J(grantsOf(M.click(st, tree, 'live', 'nvr1')).live) === J(['nvr1']))
  check('a click on a ticked camera unticks it', J(grantsOf(M.click(st, tree, 'live', 'nvr1/0')).live) === '[]')
  const pb = M.click(st, tree, 'playback-nvr', 'solus')
  check('a click on a ticked Playback SD box takes it away, and only it', J(grantsOf(pb)['playback-nvr']) === '[]' && J(grantsOf(pb)['playback-server']) === '[]')
  check('a second click gives it back, and only it', J(grantsOf(M.click(pb, tree, 'playback-nvr', 'solus'))['playback-nvr']) === J(['solus']) && J(grantsOf(M.click(pb, tree, 'playback-nvr', 'solus'))['playback-server']) === '[]')
  check('a click on Live HD ticks Live too', J(grantsOf(M.click(st, tree, 'live-hd', 'nvr1/1')).live) === J(['nvr1/0', 'nvr1/1']))
  check('a click on All sites when part-ticked ticks everything', J(grantsOf(M.click(st, tree, 'live', '*')).live) === J(['*']))
  check('a click on something not drawn changes nothing', M.click(st, tree, 'live', 'gone') === st)
}

// ---- grants the tree cannot show ------------------------------------------------------------------------
{
  const st = M.fromRow(row({ live: ['gone', 'nvr1/9', 'dark/4', 'nvr1/0'], export: ['gone/2'], 'playback-server': ['gone'] }, ['mp4']), tree)
  const v = M.view(st, tree)
  const kept = Object.fromEntries(v.kept.map((k) => [k.target, k]))
  check('each is listed once', J(v.kept.map((k) => k.target).sort()) === J(['dark/4', 'gone', 'gone/2', 'nvr1/9']), J(v.kept.map((k) => k.target)))
  check('an NVR the server no longer has is "not on this server any more"', kept.gone.reason === M.GONE && /gone/.test(kept.gone.text))
  check('so is a camera its NVR no longer lists', kept['nvr1/9'].reason === M.GONE && /Main site/.test(kept['nvr1/9'].text) && /10/.test(kept['nvr1/9'].text), kept['nvr1/9'].text)
  check('a camera on an NVR that has not listed its cameras says that instead', kept['dark/4'].reason !== M.GONE && /not listed|offline/i.test(kept['dark/4'].reason), kept['dark/4'].reason)
  check('each says which rights it carries', J(kept.gone.columns) === J(['Live', 'Playback HD']) && J(kept['gone/2'].columns) === J(['Export']), J(kept.gone.columns))
  const edited = M.toggle(st, tree, 'live', 'solus', true)
  check('an unrelated change keeps them in the saved row', ['gone', 'nvr1/9', 'dark/4'].every((t) => grantsOf(edited).live.includes(t)) && grantsOf(edited).export.includes('gone/2'))
  const dropped = M.dropKept(st, 'gone')
  check('dropKept removes one from every right, and only that one', !grantsOf(dropped).live.includes('gone') && J(grantsOf(dropped)['playback-server']) === '[]' && grantsOf(dropped).live.includes('nvr1/9'))
  const keptOnly = M.view(M.fromRow(row({ live: ['dark/4', 'nvr1/9'], export: ['gone'] }), tree), tree)
  const dark = keptOnly.sites.find((x) => x.nvr === 'dark').cells.live
  check('a kept camera on a site makes that site part-ticked, saying why no camera under it is', dark.state === 'some' && /not listed now/.test(dark.note), J(dark))
  const main = keptOnly.sites.find((x) => x.nvr === 'nvr1').cells.live
  check('...the same on a site that lists cameras, none of them ticked', main.state === 'some' && /not listed now/.test(main.note) && keptOnly.sites.find((x) => x.nvr === 'nvr1').cameras.every((c) => c.cells.live.state === 'off'), J(main))
  check('...and All sites too when that is all there is', keptOnly.all.export.state === 'some' && /not listed now/.test(keptOnly.all.export.note), J(keptOnly.all.export))
  const mixed = M.view(M.fromRow(row({ live: ['nvr1/0', 'nvr1/9'] }), tree), tree).sites.find((x) => x.nvr === 'nvr1').cells.live
  check('...but not when a camera it lists is ticked too', mixed.state === 'some' && mixed.note === '', J(mixed))
}

// ---- export formats ----------------------------------------------------------------------------------
{
  let st = M.fromRow(row({ export: ['nvr1'] }), tree)
  check('export ticked with no format is warned about', M.view(st, tree).warnings.some((w) => /format/i.test(w)))
  st = M.setFormat(st, 'stills', true)
  st = M.setFormat(st, 'pack', true)
  check('formats are saved in rights.mjs order', J(M.toRow(st).formats) === J(['pack', 'stills']))
  check('...and the warning goes', !M.view(st, tree).warnings.some((w) => /format/i.test(w)))
  st = M.setFormat(st, 'pack', false)
  check('a format can be taken away', J(M.toRow(st).formats) === J(['stills']))
  check('an unknown format is ignored', J(M.toRow(M.setFormat(st, 'exe', true)).formats) === J(['stills']))
  const f = M.view(st, tree).formats
  check('the view lists every format with its state', J(f.map((x) => [x.id, x.on])) === J([['pack', false], ['mp4', false], ['stills', true]]) && f.every((x) => x.label))
  check('formats with no export anywhere is not a warning', M.view(M.fromRow(row({}, ['mp4']), tree), tree).warnings.length === 0)
}

// ---- copy, all, none, admin --------------------------------------------------------------------------
{
  const mine = M.fromRow(row({ live: ['nvr1'] }, [], false), tree)
  const theirs = row({ live: ['solus/1', 'gone'], 'playback-nvr': ['*'], export: ['nvr-2'] }, ['mp4'])
  const copied = M.copyFrom(mine, theirs, tree)
  check('copy takes their grants and formats as they are', J(M.toRow(copied)) === J(theirs))
  const fromAdmin = M.copyFrom(mine, row({}, [], true), tree)
  check('copy never copies admin', M.toRow(fromAdmin).admin === false)
  const adminMine = M.fromRow(row({}, [], true), tree)
  check('...nor takes it away', M.toRow(M.copyFrom(adminMine, theirs, tree)).admin === true)
  const again = M.toggle(copied, tree, 'live', 'solus/1', false)
  check('changing the copy does not change what it was copied from', J(theirs.grants.live) === J(['gone', 'solus/1']) && J(M.toRow(copied).grants.live) === J(['gone', 'solus/1']) && !M.toRow(again).grants.live.includes('solus/1'))

  const all = M.setAll(mine, true)
  check("all: '*' in every right and every format", M.GRANTABLE.every((a) => J(grantsOf(all)[a]) === J(['*'])) && J(M.toRow(all).formats) === J(M.FORMATS))
  const none = M.setAll(M.fromRow(row({ live: ['nvr1', 'gone'], export: ['*'] }, ['mp4']), tree), false)
  check('none: nothing at all, the listed old grants included', J(M.toRow(none)) === J(R.emptyRights()))

  const adm = M.setAdmin(mine, true)
  check('the admin switch is saved', M.toRow(adm).admin === true && M.toRow(M.setAdmin(adm, false)).admin === false)
  check("an admin's ticks are kept for the day they stop being admin", J(grantsOf(adm).live) === J(['nvr1']))
  const av = M.view(adm, tree)
  check('an admin is shown as covering everything', av.admin === true && /everything/i.test(av.adminNote), av.adminNote)
  const users = [{ user: 'jo', admin: false }, { user: 'boss', admin: true }, { user: 'al', admin: false }, { user: 'me', admin: false }, null]
  check('copy is offered from the other viewers only, never from an admin or oneself', J(M.copySources(users, 'me')) === J(['al', 'jo']) && M.copySources(null, 'me').length === 0)
  check('a viewer with nothing ticked is told so', M.view(M.fromRow(row(), tree), tree).nothing === true && M.view(mine, tree).nothing === false)
}

// ---- dirty tracking ----------------------------------------------------------------------------------
{
  const a = M.fromRow(row({ live: ['nvr1'] }), tree)
  check('sameRow: the same state is the same', M.sameRow(M.toRow(a), M.toRow(M.fromRow(row({ live: ['nvr1'] }), tree))))
  const b = M.toggle(M.toggle(a, tree, 'live', 'nvr1/0', false), tree, 'live', 'nvr1/0', true)
  check('unticking and ticking back is no change', M.sameRow(M.toRow(a), M.toRow(b)), J(M.toRow(b)))
  check('a real change is a change', !M.sameRow(M.toRow(a), M.toRow(M.setFormat(a, 'mp4', true))))
}

// ---- whatever the admin clicks, the row is one rights.mjs stores unchanged ------------------------------
{
  // a small deterministic generator (no Math.random: a failure must be repeatable)
  let seed = 12345
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const targets = ['*', ...tree.map((n) => n.nvr), ...tree.flatMap((n) => n.cameras.map((c) => `${n.nvr}/${c.ch}`)), 'gone', 'gone/3', 'nvr1/9']
  const columns = [...M.COLUMNS]
  let bad = null
  let state = M.fromRow(row({ live: ['gone', 'nvr1/9'] }), tree)
  for (let i = 0; i < 3000 && !bad; i++) {
    const r = rnd(20)
    if (r === 0) state = M.setAll(state, rnd(2) === 0)
    else if (r === 1) state = M.setFormat(state, M.FORMATS[rnd(3)], rnd(2) === 0)
    else if (r === 2) state = M.dropKept(state, targets[rnd(targets.length)])
    else state = M.toggle(state, tree, columns[rnd(columns.length)], targets[rnd(targets.length)], rnd(2) === 0)
    const out = M.toRow(state)
    if (J(R.cleanRights(out)) !== J(out)) bad = { i, out }
    // and the ticks shown are what the row grants: every camera cell agrees with can()'s rule
    const v = M.view(state, tree)
    for (const n of tree) for (const c of n.cameras) {
      const cells = v.sites.find((s) => s.nvr === n.nvr).cameras.find((x) => x.ch === c.ch).cells
      const covers = (list) => list.includes('*') || list.includes(n.nvr) || list.includes(`${n.nvr}/${c.ch}`)
      const want = Object.fromEntries(columns.map((col) => [col, covers(out.grants[col])]))
      for (const col of columns) if ((cells[col].state === 'on') !== want[col]) bad = bad ?? { i, cam: `${n.nvr}/${c.ch}`, col, cell: cells[col], out }
      // the editor keeps Live HD inside Live: never HD on a camera without Live
      if (want['live-hd'] && !want.live) bad = bad ?? { i, cam: `${n.nvr}/${c.ch}`, hdWithoutLive: true, out }
    }
    // a ticked site box is the NVR target (or '*'): the one tick that also covers cameras added later
    for (const s of v.sites) {
      const whole = out.grants.live.includes('*') || out.grants.live.includes(s.nvr)
      if ((s.cells.live.state === 'on') !== whole) bad = bad ?? { i, site: s.nvr, cell: s.cells.live, out }
    }
    if ((v.all.live.state === 'on') !== out.grants.live.includes('*')) bad = bad ?? { i, all: v.all.live, out }
  }
  check('3000 random clicks: every row is already clean, every camera tick matches the row, and Live HD stays inside Live', bad === null, J(bad))
}

// ---- a stored Live HD list survives a save (stream rights): the editor never drops it ---------------------
check('Live HD kept through the editor: fromRow then toRow gives the same list', J(M.toRow(M.fromRow(row({ live: ['nvr1'], 'live-hd': ['nvr1'] }), tree)).grants['live-hd']) === J(['nvr1']))

// ---- the editor's phone layout (style.css): two rules a browser would otherwise override ----------------
{
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
  // `.ac-tree small { display: block }` outranks a bare `.ac-row-notes`, so the notes would show twice
  check('the row header\'s notes are hidden on wide screens, by a rule that outranks .ac-tree small', /^\.ac-tree \.ac-row-notes \{ display: none;/m.test(css))
  const phone = css.slice(css.lastIndexOf('@media (max-width: 560px) {', css.indexOf('.ac-tree thead th.ac-col { width: 44px; }')))
  check('on a phone the editor is 100vw - 16px wide, past the browser\'s own cap on a modal dialog', /^\s*\.ac-dialog \{ width: calc\(100vw - 16px\); max-width: calc\(100vw - 16px\); padding: 10px; \}/m.test(phone.slice(0, phone.indexOf('\n}'))))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
