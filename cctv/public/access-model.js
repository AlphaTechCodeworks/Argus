// The access editor's model (Audit page, "Users & access"): one user's stored rights row turned
// into ticks over the site -> camera tree, changed the way the editor's boxes change it, and turned
// back into a row for POST /api/admin/rights. Pure and DOM-free, so every rule is tested with plain
// node (test/access-model.test.mjs); audit.js does the drawing.
//
// The row is rights.mjs's own: { admin, grants: { live, 'playback-server', 'playback-nvr', export },
// formats }, each grant a list of '*' (everything), '<nvr>' (that NVR, cameras added later
// included) or '<nvr>/<ch>' (one camera, channel from 0). The editor never invents another shape,
// and the test proves every row it can produce is one rights.mjs cleanRights stores unchanged.
//
// Four rules decide what someone may see without the admin noticing, so they are the model's job and
// not the page's:
//   - A site tick is the NVR target: it covers cameras added to that NVR later. Ticking the last
//     camera of a site makes it the NVR target; cameras stored one by one are NOT widened on load,
//     because that would grant tomorrow's cameras to someone the admin never ticked a site for.
//   - Unticking one camera of a ticked site (or of All sites) keeps the rest: the NVR target, or
//     '*', becomes the cameras and sites that are left.
//   - Playback is two rights (the server's recordings and the NVR's own). A tick sets or clears
//     both; a cell nobody touched keeps whatever split it was stored with.
//   - A grant the tree cannot show (an NVR removed from the server, a camera its NVR no longer lists)
//     is kept and listed, never dropped just because the page could not draw it.
//
// Editor state, never shared with the row it came from (every change returns a new state):
//   { admin, formats, grants: { <action>: { all, nvrs: [id], cams: ['id/ch'], kept: [target] } } }
// all is '*'; nvrs and cams are targets on the tree; kept is every other target, as stored.

/** The per-camera rights rights.mjs knows ('admin' is the account's role, not a grant). */
export const GRANTABLE = Object.freeze(['live', 'playback-server', 'playback-nvr', 'export'])
/** Export formats, in rights.mjs's order (it saves them in this order whatever order they are ticked). */
export const FORMATS = Object.freeze(['pack', 'mp4', 'stills'])
export const FORMAT_LABELS = Object.freeze({ pack: 'Evidence pack', mp4: 'MP4', stills: 'Stills' })

/** The editor's three tick columns, and the stored rights each one sets. */
export const COLUMNS = Object.freeze(['live', 'playback', 'export'])
export const COLUMN_LABELS = Object.freeze({ live: 'Live', playback: 'Playback', export: 'Export' })
const COLUMN_ACTIONS = Object.freeze({ live: ['live'], playback: ['playback-server', 'playback-nvr'], export: ['export'] })

/** Said of a kept grant whose NVR or camera the server no longer has. */
export const GONE = 'not on this server any more'
const UNLISTED = 'its NVR has not listed its cameras yet (offline?)'
const ONE_BY_ONE_CAMS = 'every camera, one by one: a camera added later is not included'
const ONE_BY_ONE_SITES = 'every site, one by one: a site added later is not included'
// part-ticked by nothing but kept grants: without this the box looks wrong, nothing under it being ticked
const KEPT_ONLY = 'only cameras not listed now (see Kept from before)'
const KEPT_ONLY_ALL = 'only sites or cameras not listed now (see Kept from before)'

const isString = (v) => typeof v === 'string'
const arr = (v) => (Array.isArray(v) ? v : [])
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0) // rights.mjs sorts with the default sort: the same order

// ------------------------------------------------------------------ the row, as rights.mjs reads it

/**
 * rights.mjs cleanTarget, line for line: the page cannot import it (it reads files), and the test
 * checks the two accept and normalise exactly the same things.
 */
export function cleanTarget(t) {
  if (!isString(t)) return null
  if (t === '*') return '*'
  const slash = t.indexOf('/')
  if (slash === -1) return /^[\w.:-]{1,64}$/.test(t) ? t : null
  const nvr = t.slice(0, slash)
  const ch = t.slice(slash + 1)
  if (!/^[\w.:-]{1,64}$/.test(nvr)) return null
  if (!/^\d{1,3}$/.test(ch)) return null
  return `${nvr}/${Number(ch)}`
}

/** rights.mjs cleanRights for the page: whatever arrived, as a row rights.mjs would store. */
export function cleanRow(raw) {
  const ok = raw && typeof raw === 'object' && !Array.isArray(raw)
  const grants = ok && raw.grants && typeof raw.grants === 'object' && !Array.isArray(raw.grants) ? raw.grants : {}
  const out = { admin: ok && raw.admin === true, grants: {}, formats: [] }
  for (const a of GRANTABLE) out.grants[a] = [...new Set(arr(grants[a]).map(cleanTarget).filter(Boolean))].sort(byText)
  const formats = ok ? arr(raw.formats) : []
  out.formats = FORMATS.filter((f) => formats.includes(f))
  return out
}

/** Whether two rows grant exactly the same (the editor's "unsaved changes"). */
export const sameRow = (a, b) => JSON.stringify(cleanRow(a)) === JSON.stringify(cleanRow(b))

// ------------------------------------------------------------------------------------- the tree

/**
 * The site -> camera tree from what an admin is sent by /api/sites ({ id, site, name } per NVR) and
 * /api/cameras ({ nvr, ch, name, configured, site, nvrName } per camera). One row per NVR, labelled
 * with its site, sorted by site then NVR name as the Live page sorts them. An NVR with no cameras
 * listed (offline since the server started) still has its row, so it can still be granted. An empty
 * channel slot (configured false) is not a camera. Anything that could not be a rights target is
 * left out rather than guessed at.
 * @returns {{nvr:string, site:string, name:string, cameras:{ch:number, name:string}[]}[]}
 */
export function buildTree(sites, cameras) {
  const byId = new Map()
  const add = (id, site, name) => {
    if (!isString(id) || id === '*' || id.includes('/') || cleanTarget(id) !== id) return null
    if (!byId.has(id)) {
      const siteName = isString(site) && site.trim() ? site.trim() : id
      byId.set(id, { nvr: id, site: siteName, name: isString(name) && name.trim() ? name.trim() : siteName, cameras: [] })
    }
    return byId.get(id)
  }
  for (const s of arr(sites)) if (s && typeof s === 'object') add(s.id, s.site, s.name)
  for (const c of arr(cameras)) {
    if (!c || typeof c !== 'object' || c.configured === false) continue
    if (!Number.isInteger(c.ch) || c.ch < 0 || c.ch > 999) continue
    const node = byId.get(c.nvr) ?? add(c.nvr, c.site, c.nvrName)
    if (!node || node.cameras.some((x) => x.ch === c.ch)) continue
    node.cameras.push({ ch: c.ch, name: isString(c.name) && c.name.trim() ? c.name.trim() : `Camera ${c.ch + 1}` })
  }
  const tree = [...byId.values()]
  for (const n of tree) n.cameras.sort((a, b) => a.ch - b.ch)
  return tree.sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name) || byText(a.nvr, b.nvr))
}

// the tree as lookups; kept per tree, which the editor builds once per opening
const indexes = new WeakMap()
function indexOf(tree) {
  const list = arr(tree)
  if (indexes.has(list)) return indexes.get(list)
  const nvrs = new Map()
  for (const n of list) nvrs.set(n.nvr, { node: n, keys: n.cameras.map((c) => `${n.nvr}/${c.ch}`) })
  const idx = { nvrs, ids: [...nvrs.keys()] }
  if (Array.isArray(tree)) indexes.set(tree, idx)
  return idx
}

const nvrOf = (t) => (t.includes('/') ? t.slice(0, t.indexOf('/')) : t)
const onNvr = (id) => (t) => t === id || t.startsWith(`${id}/`)
const notOnNvr = (id) => (t) => !onNvr(id)(t)

// ------------------------------------------------------------------------------------ row <-> state

const emptyCov = () => ({ all: false, nvrs: [], cams: [], kept: [] })

/** One stored list, split into what the tree shows ('*', its sites, its cameras) and what it cannot. */
function split(list, idx) {
  const cov = emptyCov()
  for (const t of list) {
    if (t === '*') cov.all = true
    else if (!t.includes('/')) (idx.nvrs.has(t) ? cov.nvrs : cov.kept).push(t)
    else (idx.nvrs.get(nvrOf(t))?.keys.includes(t) ? cov.cams : cov.kept).push(t)
  }
  return cov
}

/** A stored row (GET /api/admin/rights, one user) as the editor's state over this tree. */
export function fromRow(row, tree) {
  const clean = cleanRow(row)
  const idx = indexOf(tree)
  const grants = {}
  for (const a of GRANTABLE) grants[a] = split(clean.grants[a], idx)
  return { admin: clean.admin, grants, formats: clean.formats }
}

/** The state as the row to POST. Nothing is merged or tidied that the admin did not change. */
export function toRow(state) {
  const grants = {}
  for (const a of GRANTABLE) {
    const c = state?.grants?.[a] ?? emptyCov()
    grants[a] = [...new Set([...(c.all ? ['*'] : []), ...c.nvrs, ...c.cams, ...c.kept])].sort(byText)
  }
  return { admin: state?.admin === true, grants, formats: FORMATS.filter((f) => arr(state?.formats).includes(f)) }
}

const copyCov = (c) => ({ all: c.all, nvrs: [...c.nvrs], cams: [...c.cams], kept: [...c.kept] })
const copyState = (s) => ({ admin: s.admin, formats: [...s.formats], grants: Object.fromEntries(GRANTABLE.map((a) => [a, copyCov(s.grants[a])])) })

// ----------------------------------------------------------------------------------------- changes

/** One stored right after one box is ticked (on) or unticked on target. */
function apply(cov, target, on, idx) {
  const c = copyCov(cov)
  if (target === '*') return on ? { ...emptyCov(), all: true } : emptyCov() // the whole column, the listed old grants included

  const id = nvrOf(target)
  const site = idx.nvrs.get(id)
  const others = idx.ids.filter((x) => x !== id)

  if (target === id) {
    if (on) {
      if (c.all) return c
      // the site target covers its cameras, and any it no longer lists: none needs a grant of its own
      return { ...c, nvrs: [...new Set([...c.nvrs, id])], cams: c.cams.filter(notOnNvr(id)), kept: c.kept.filter(notOnNvr(id)) }
    }
    // Nothing on this site. Under '*' that is every other site the tree shows, each whole.
    if (c.all) return { all: false, nvrs: others, cams: [], kept: c.kept.filter(notOnNvr(id)) }
    return { ...c, nvrs: c.nvrs.filter((x) => x !== id), cams: c.cams.filter(notOnNvr(id)), kept: c.kept.filter(notOnNvr(id)) }
  }

  if (on) {
    if (c.all || c.nvrs.includes(id) || c.cams.includes(target)) return c
    const cams = [...c.cams, target]
    // the last camera of a site ticked: the site itself, so a camera added to it later is included
    if (site.keys.every((k) => cams.includes(k))) return { ...c, nvrs: [...c.nvrs, id], cams: cams.filter(notOnNvr(id)), kept: c.kept.filter(notOnNvr(id)) }
    return { ...c, cams }
  }
  const rest = site.keys.filter((k) => k !== target)
  // One camera taken out of '*' or out of a whole site: what was covered stays covered, minus it.
  if (c.all) return { ...c, all: false, nvrs: others, cams: rest }
  if (c.nvrs.includes(id)) return { ...c, nvrs: c.nvrs.filter((x) => x !== id), cams: [...c.cams.filter(notOnNvr(id)), ...rest] }
  return { ...c, cams: c.cams.filter((k) => k !== target) }
}

/**
 * One box ticked (on true) or unticked. column: 'live', 'playback' (both playback rights) or
 * 'export'. target: '*' for All sites, an NVR id for a site row, 'nvr/ch' for a camera row. A column
 * or target the tree does not have changes nothing.
 */
export function toggle(state, tree, column, target, on) {
  const actions = Object.hasOwn(COLUMN_ACTIONS, column) ? COLUMN_ACTIONS[column] : null
  const t = cleanTarget(target)
  const idx = indexOf(tree)
  if (!actions || !t) return state
  if (t !== '*' && !(t.includes('/') ? idx.nvrs.get(nvrOf(t))?.keys.includes(t) : idx.nvrs.has(t))) return state
  const next = copyState(state)
  for (const a of actions) next.grants[a] = apply(next.grants[a], t, on === true, idx)
  return next
}

/** Everything ('*' in every right, every format), or nothing at all, the listed old grants included. */
export function setAll(state, on) {
  const next = copyState(state)
  for (const a of GRANTABLE) next.grants[a] = on ? { ...emptyCov(), all: true } : emptyCov()
  next.formats = on ? [...FORMATS] : []
  return next
}

export function setFormat(state, format, on) {
  if (!FORMATS.includes(format)) return state
  const next = copyState(state)
  next.formats = FORMATS.filter((f) => (f === format ? on === true : state.formats.includes(f)))
  return next
}

/** The Admin switch. The ticks stay as they are: they apply again the day Admin is switched off. */
export const setAdmin = (state, on) => ({ ...copyState(state), admin: on === true })

/** Another user's grants and formats, as they are. Never their admin: that stays this user's own. */
export const copyFrom = (state, row, tree) => ({ ...fromRow(row, tree), admin: state.admin === true })

/** Removes one listed old grant (see view().kept) from every right that has it. */
export function dropKept(state, target) {
  const next = copyState(state)
  for (const a of GRANTABLE) next.grants[a].kept = next.grants[a].kept.filter((t) => t !== target)
  return next
}

/** Who can be copied from: the other accounts that are not admins (an admin's ticks are not what they see). */
export function copySources(users, name) {
  return arr(users)
    .filter((u) => u && isString(u.user) && u.user !== name && u.admin !== true)
    .map((u) => u.user)
    .sort(byText)
}

// -------------------------------------------------------------------------------------- the view

const hasAny = (c) => c.all || c.nvrs.length > 0 || c.cams.length > 0 || c.kept.length > 0

/** One right on one site row: 'on' (the site, or '*'), 'some', or 'off', and why when it is not plain. */
function siteCell(c, site) {
  if (c.all || c.nvrs.includes(site.node.nvr)) return { state: 'on', note: '' }
  const mine = onNvr(site.node.nvr)
  const listed = c.cams.some(mine)
  if (!listed && !c.kept.some(mine)) return { state: 'off', note: '' }
  if (!listed) return { state: 'some', note: KEPT_ONLY }
  const every = site.keys.length > 0 && site.keys.every((k) => c.cams.includes(k))
  return { state: 'some', note: every ? ONE_BY_ONE_CAMS : '' }
}

function allCell(c, idx) {
  if (c.all) return { state: 'on', note: '' }
  if (!hasAny(c)) return { state: 'off', note: '' }
  if (c.nvrs.length === 0 && c.cams.length === 0) return { state: 'some', note: KEPT_ONLY_ALL }
  const every = idx.ids.length > 0 && idx.ids.every((id) => c.nvrs.includes(id))
  return { state: 'some', note: every ? ONE_BY_ONE_SITES : '' }
}

const RANK = { off: 0, some: 1, on: 2 }
const WORD = { on: 'all', some: 'some', off: 'none' }

/**
 * The Playback box from its two rights. Ticked when either covers it, because unticking it takes
 * both away; a cell where the two differ says so, since "ticked" alone would hide that one of them
 * is missing.
 */
function playbackCell(server, nvr) {
  const state = RANK[server.state] >= RANK[nvr.state] ? server.state : nvr.state
  if (server.state === nvr.state) return { state, note: server.note === nvr.note ? server.note : '' }
  if (nvr.state === 'off') return { state, note: 'server recordings only' }
  if (server.state === 'off') return { state, note: 'NVR recordings only' }
  return { state, note: `server recordings: ${WORD[server.state]}; NVR recordings: ${WORD[nvr.state]}` }
}

const cellsOf = (one) => ({ live: one('live'), playback: playbackCell(one('playback-server'), one('playback-nvr')), export: one('export') })

const KEPT_LABELS = { live: 'Live', 'playback-server': 'Playback (server)', 'playback-nvr': 'Playback (NVR)', export: 'Export' }

/** The old grants the tree cannot show, one entry per target, with the rights it carries. */
function keptList(state, idx) {
  const by = new Map()
  for (const a of GRANTABLE) for (const t of state.grants[a].kept) by.set(t, [...(by.get(t) ?? []), a])
  return [...by.keys()].sort(byText).map((t) => {
    const actions = by.get(t)
    const site = idx.nvrs.get(nvrOf(t))
    const ch = t.includes('/') ? Number(t.slice(t.indexOf('/') + 1)) : null
    const text = ch === null ? `all of ${t}` : `${site ? site.node.site : nvrOf(t)} camera ${ch + 1}`
    const both = actions.includes('playback-server') && actions.includes('playback-nvr')
    const columns = actions.filter((a) => !(both && a === 'playback-nvr')).map((a) => (both && a === 'playback-server' ? 'Playback' : KEPT_LABELS[a]))
    return { target: t, text, reason: site && site.keys.length === 0 ? UNLISTED : GONE, columns }
  })
}

/**
 * What the editor draws. Every cell is { state: 'on'|'some'|'off', note }: 'on' is a ticked box,
 * 'some' a part-ticked one (some cameras under it), and note, when not empty, says what the tick
 * alone would hide. A click on a cell is toggle(state, tree, column, target, cell.state !== 'on').
 */
export function view(state, tree) {
  const idx = indexOf(tree)
  const g = state.grants
  const sites = [...idx.nvrs.values()].map((site) => {
    const { node } = site
    return {
      nvr: node.nvr,
      site: node.site,
      name: node.name,
      cells: cellsOf((a) => siteCell(g[a], site)),
      cameras: node.cameras.map((c) => {
        const key = `${node.nvr}/${c.ch}`
        const covered = (a) => ({ state: g[a].all || g[a].nvrs.includes(node.nvr) || g[a].cams.includes(key) ? 'on' : 'off', note: '' })
        return { ch: c.ch, key, name: c.name, cells: cellsOf(covered) }
      })
    }
  })
  const exportsSomething = hasAny(g.export)
  const warnings = []
  if (!state.admin && exportsSomething && state.formats.length === 0) {
    warnings.push('Export is ticked, but no format is: they cannot export anything until a format is ticked.')
  }
  return {
    admin: state.admin,
    adminNote: 'An admin may watch, play back and export everything, on every site and camera, in any format, and can change all of this. Switch Admin off to choose what they may see.',
    nothing: !state.admin && !GRANTABLE.some((a) => hasAny(g[a])),
    all: cellsOf((a) => allCell(g[a], idx)),
    sites,
    kept: keptList(state, idx),
    formats: FORMATS.map((id) => ({ id, label: FORMAT_LABELS[id], on: state.formats.includes(id) })),
    warnings
  }
}

/** The cell a box shows: All sites ('*'), a site row (NVR id) or a camera row ('nvr/ch'); null if not drawn. */
export function cellAt(v, column, target) {
  if (!COLUMNS.includes(column)) return null
  if (target === '*') return v.all[column]
  for (const s of v.sites) {
    if (s.nvr === target) return s.cells[column]
    const c = s.cameras.find((x) => x.key === target)
    if (c) return c.cells[column]
  }
  return null
}

/**
 * A click on a box: a ticked box is unticked, a part-ticked or empty one ticked, like any checkbox.
 * So a Playback box ticked for one of its two rights takes both away, and a second click grants both.
 */
export function click(state, tree, column, target) {
  const cell = cellAt(view(state, tree), column, target)
  return cell ? toggle(state, tree, column, target, cell.state !== 'on') : state
}
