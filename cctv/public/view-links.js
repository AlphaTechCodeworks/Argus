// The Live page's links to a saved view, and its cycling through views: what an address asks for,
// the address for a view, and which view comes next. No DOM, so it is tested offline
// (test/view-links.test.mjs); viewer.js does the showing.
//
//   /index.html?view=<id>                    open Live on that view (one's own, or one shared with
//                                            everyone; &from=<owner> says whose, when two could match)
//   ...&screen=1                             a clean screen for a TV or a second monitor: the grid and
//                                            the camera names, no sidebar and no controls
//   /index.html?cycle=<id>,<id>&every=30     go round those views, 30 s on each
//
// A view in the page's own menu is named by a "menu id": its id when it is the user's own, and
// "s|<owner>|<id>" when somebody shared it, because two users' ids are only unique each in their own
// list. A view id is [A-Za-z0-9_-], so the last "|" always ends the owner.

/** Seconds on each view while cycling: the default, and the least and most allowed. */
export const CYCLE_DEFAULT_S = 30
export const CYCLE_MIN_S = 10
export const CYCLE_MAX_S = 300
/** How long after the viewer last clicked, tapped or pressed a key the cycle waits before moving on. */
export const CYCLE_IDLE_MS = 20_000
/** The most views one cycle goes round (the most a user can have of their own). */
export const CYCLE_MAX_VIEWS = 50

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Seconds per view, clamped; anything that is not a number is the default. */
export function cycleSeconds(raw) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || raw === null || raw === '' || raw === undefined) return CYCLE_DEFAULT_S
  return Math.min(CYCLE_MAX_S, Math.max(CYCLE_MIN_S, n))
}

/** The menu id of a view: its own id, or "s|owner|id" for one shared by somebody else. */
export function menuId(view) {
  return view?.owner ? `s|${view.owner}|${view.id}` : String(view?.id ?? '')
}

/** A menu id taken apart: { owner, id } (owner '' for the user's own), or null when it is no menu id. */
export function parseMenuId(value) {
  const s = String(value ?? '')
  if (s.startsWith('s|')) {
    const cut = s.lastIndexOf('|')
    const owner = s.slice(2, cut)
    const id = s.slice(cut + 1)
    return cut > 1 && owner && ID_RE.test(id) ? { owner, id } : null
  }
  return ID_RE.test(s) ? { owner: '', id: s } : null
}

/**
 * The view a link names, out of the user's own and the shared ones: their own first (a link they
 * copied of their own view must open that), then a shared one by the same id, from `from` if given.
 */
export function findLinkedView(own, shared, id, from = '') {
  if (!id) return null
  if (!from) {
    const mine = (own ?? []).find((v) => v.id === id)
    if (mine) return mine
  }
  return (shared ?? []).find((v) => v.id === id && (!from || v.owner === from)) ?? null
}

/**
 * What a Live address asks for about views.
 * @returns {{ view: string|null, from: string, screen: boolean, cycle: string[]|null, every: number }}
 */
export function readViewLink(search) {
  const p = new URLSearchParams(search ?? '')
  const view = p.get('view')
  const ids = (p.get('cycle') ?? '').split(',').map((s) => s.trim()).filter((s) => parseMenuId(s) !== null)
  const cycle = [...new Set(ids)].slice(0, CYCLE_MAX_VIEWS)
  return {
    view: view && ID_RE.test(view) ? view : null,
    from: (p.get('from') ?? '').slice(0, 64),
    screen: ['1', 'true', 'yes'].includes(p.get('screen') ?? ''),
    cycle: cycle.length >= 2 ? cycle : null,
    every: cycleSeconds(p.get('every'))
  }
}

/** The address of a view, for "Copy link": origin + /index.html?view=…, with &from for a shared one
 *  and &screen=1 for the TV screen. */
export function viewHref(origin, view, { screen = false } = {}) {
  const p = new URLSearchParams({ view: String(view?.id ?? '') })
  if (view?.owner) p.set('from', view.owner)
  if (screen) p.set('screen', '1')
  return `${String(origin ?? '').replace(/\/$/, '')}/index.html?${p}`
}

/** The cycle as remembered in this browser, tidied: { ids, every, on }; nothing usable is null. */
export function readCycle(text) {
  let j
  try {
    j = JSON.parse(text ?? 'null')
  } catch {
    return null
  }
  if (j === null || typeof j !== 'object' || !Array.isArray(j.ids)) return null
  const ids = [...new Set(j.ids.filter((s) => typeof s === 'string' && parseMenuId(s) !== null))].slice(0, CYCLE_MAX_VIEWS)
  return { ids, every: cycleSeconds(j.every), on: j.on === true && ids.length >= 2 }
}

/**
 * The view to show next: the one after `current` in the cycle, skipping any no longer available
 * (deleted, or no longer shared). Null when fewer than two are left, so a cycle of one stays put.
 * @param {string[]} ids the cycle's menu ids, in order
 * @param {string} current the menu id on screen ('' for none)
 * @param {(id: string) => boolean} available
 */
export function nextCycleId(ids, current, available = () => true) {
  const list = (ids ?? []).filter((id) => available(id))
  if (list.length < 2) return null
  const at = (ids ?? []).indexOf(current)
  if (at < 0) return list[0] === current ? list[1] : list[0]
  for (let step = 1; step <= ids.length; step++) {
    const id = ids[(at + step) % ids.length]
    if (id !== current && available(id)) return id
  }
  return null
}

/**
 * Whether the cycle may move on now: not while the full-size view or a dialog is open, the tab is
 * hidden, or the viewer clicked or pressed a key in the last CYCLE_IDLE_MS; and only once the view
 * has been up for its whole time since then.
 */
export function cycleDue({ now, shownAt, lastInput = 0, everyS, paused = false }) {
  if (paused) return false
  if (now - lastInput < CYCLE_IDLE_MS) return false
  return now - Math.max(shownAt, lastInput) >= cycleSeconds(everyS) * 1000
}

/** Where the sign-in page may send the browser back to: only this app's Live page with its query. */
export function safeNext(raw) {
  const s = String(raw ?? '')
  return /^\/(index\.html)?\?[A-Za-z0-9=&,|%._~-]{0,512}$/.test(s) ? s : null
}
