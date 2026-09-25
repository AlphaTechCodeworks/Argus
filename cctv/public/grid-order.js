// The live grid's camera order, each user their own (saved on the server: PUT /api/me/grid-order,
// see user-prefs.mjs). An order is a list of camera keys "<nvr>/<ch>"; [] is the default order
// (site, NVR, channel: the order /api/cameras sends). One global list: the site filter and "Hide
// offline" only hide entries. Cameras missing from the order follow it in default order; keys of
// cameras that no longer exist stay in it (so a camera that comes back comes back in its place)
// but are not shown.
//
// The same user may have the grid open on several screens (a desk PC, a wall monitor). A change is
// kept as an operation (swap two cameras, move one before/after another, reset) made on a version
// of the server's order. Saving sends the resulting order with that version; if another screen
// saved in between, the server refuses it (409) with its newer order, and the operations are done
// again on that one, so neither screen's change is lost. Operations are safe to do twice (a swap
// already done is not undone), so a save whose answer was lost can simply be sent again. Every
// camera-list refresh (30 s) and a tab shown again re-read the order, so every screen follows.
// Pure functions plus a DOM-free sync; tested offline: test/grid-order.test.mjs.

/** The same rules as the server (user-prefs.mjs). */
export const KEY_RE = /^[A-Za-z0-9._-]{1,64}\/\d{1,4}$/
export const MAX_KEYS = 4096
/** Unsaved changes kept at most (beyond: folded into one "set" of the order they led to). */
export const MAX_OPS = 200
/** Saves refused because another screen saved first, done again before giving up for now. */
export const MAX_CONFLICT_TRIES = 3

const keyOf = (c) => `${c.nvr}/${c.ch}`

/**
 * The cameras in the saved order: the saved ones first, the rest after them in list order.
 * @param {object[]} cameras in default order
 * @param {string[]} [order]
 * @returns {object[]} a new array of the same camera objects
 */
export function applyOrder(cameras, order) {
  if (!order?.length) return [...cameras]
  const byKey = new Map(cameras.map((c) => [keyOf(c), c]))
  const placed = new Set()
  const out = []
  for (const k of order) {
    const c = byKey.get(k)
    if (c && !placed.has(c)) {
      placed.add(c)
      out.push(c)
    }
  }
  for (const c of cameras) if (!placed.has(c)) out.push(c)
  return out
}

/** The whole order a change starts from: the saved keys (stale ones too), then every other camera in list order. */
export function effectiveOrder(order, cameras) {
  const out = [...new Set(order ?? [])]
  const have = new Set(out)
  for (const c of cameras) {
    const k = keyOf(c)
    if (!have.has(k)) {
      have.add(k)
      out.push(k)
    }
  }
  return out
}

// ---- changes, as operations ----------------------------------------------------------------------
//   { op: 'swap', a, b }            a (before b when the change was made) and b change places;
//                                   nothing if b is already before a (done already, or elsewhere)
//   { op: 'move', key, before: k }  key goes just before k   (or after: k, just after k)
//   { op: 'reset' }                 the default order
//   { op: 'set', order }            that order (many unsaved changes folded into one)

const isKey = (k) => typeof k === 'string' && KEY_RE.test(k)

/** A well-formed operation (e.g. one read back from this browser's storage). */
export function isOp(op) {
  if (!op || typeof op !== 'object') return false
  switch (op.op) {
    case 'swap':
      return isKey(op.a) && isKey(op.b) && op.a !== op.b
    case 'move': {
      const anchor = op.before ?? op.after
      return isKey(op.key) && (op.before === undefined) !== (op.after === undefined) && isKey(anchor) && anchor !== op.key
    }
    case 'reset':
      return true
    case 'set':
      return Array.isArray(op.order) && op.order.every(isKey)
    default:
      return false
  }
}

/**
 * The order after one operation: the whole order (every camera) when it changed something, else
 * a copy of the order as it was (keys it names that are neither saved nor a camera now: skipped).
 */
export function applyOp(order, op, cameras) {
  const unchanged = [...(order ?? [])]
  if (op?.op === 'reset') return []
  if (op?.op === 'set') return cleanOrder(op.order)
  const e = effectiveOrder(order, cameras)
  if (op?.op === 'swap') {
    const i = e.indexOf(op.a)
    const j = e.indexOf(op.b)
    if (i < 0 || j < 0 || i >= j) return unchanged
    ;[e[i], e[j]] = [e[j], e[i]]
    return e
  }
  if (op?.op === 'move') {
    const anchor = op.before ?? op.after
    if (anchor === op.key || !e.includes(op.key) || !e.includes(anchor)) return unchanged
    const rest = e.filter((k) => k !== op.key)
    const at = rest.indexOf(anchor) + (op.before === undefined ? 1 : 0)
    rest.splice(at, 0, op.key)
    return rest
  }
  return unchanged
}

/** The order after the operations, in turn. */
export const applyOps = (order, ops, cameras) => ops.reduce((o, op) => applyOp(o, op, cameras), [...(order ?? [])])

/** The swap of two cameras as an operation (a: the one before now), or null (not two cameras). */
export function swapOp(order, a, b, cameras) {
  const e = effectiveOrder(order, cameras)
  const i = e.indexOf(a)
  const j = e.indexOf(b)
  if (i < 0 || j < 0 || i === j) return null
  return i < j ? { op: 'swap', a, b } : { op: 'swap', a: b, b: a }
}

/** Two cameras change places (the rest stay where they are). Unknown keys: the order unchanged. */
export function swapKeys(order, a, b, cameras) {
  const op = swapOp(order, a, b, cameras)
  return op ? applyOp(order, op, cameras) : [...(order ?? [])]
}

/**
 * The camera to the first place of another page (the pager arrows), as an operation: just
 * before the camera that will then be shown at that place, or after the last one shown. Pages
 * count the cameras shown (site filter, Hide offline). null: no such page, or not shown.
 * @param {string} key the camera moved
 * @param {number} pageIndex 0-based page it goes to
 * @param {number} perPage tiles per page
 * @param {object[]} visibleCameras every camera shown, on all pages, in display order
 */
export function moveOp(key, pageIndex, perPage, visibleCameras) {
  const shown = visibleCameras.map(keyOf)
  const pages = Math.max(1, Math.ceil(shown.length / perPage))
  if (!shown.includes(key) || !(perPage >= 1) || !(pageIndex >= 0) || pageIndex >= pages) return null
  const rest = shown.filter((k) => k !== key)
  if (rest.length === 0) return null
  const at = pageIndex * perPage
  return at < rest.length ? { op: 'move', key, before: rest[at] } : { op: 'move', key, after: rest.at(-1) }
}

/**
 * The camera goes to the first place of another page (see moveOp); hidden cameras keep their
 * places in the list.
 * @param {object[]} [cameras] every camera (for the full order); by default the shown ones
 */
export function moveToPage(order, key, pageIndex, perPage, visibleCameras, cameras = visibleCameras) {
  const op = moveOp(key, pageIndex, perPage, visibleCameras)
  return op ? applyOp(order, op, cameras) : [...(order ?? [])]
}

/** The default order. */
export const reset = () => []

/**
 * What may be saved: valid keys, each once (first place wins), at most MAX_KEYS. Over the
 * limit, keys of cameras that no longer exist are dropped first (from the end).
 * @param {unknown} order
 * @param {object[]} [cameras]
 */
export function cleanOrder(order, cameras = null) {
  if (!Array.isArray(order)) return []
  let out = [...new Set(order.filter((k) => typeof k === 'string' && KEY_RE.test(k)))]
  if (out.length > MAX_KEYS && cameras) {
    const live = new Set(cameras.map(keyOf))
    let extra = out.length - MAX_KEYS
    const drop = new Set()
    for (let i = out.length - 1; i >= 0 && extra > 0; i--) {
      if (!live.has(out[i])) {
        drop.add(i)
        extra--
      }
    }
    out = out.filter((_, i) => !drop.has(i))
  }
  return out.slice(0, MAX_KEYS)
}

/**
 * Which of the grid's tiles a re-layout can keep (moved to another cell, their video playing on).
 * @param {(string | null)[]} oldKeys the camera in each cell now (null: empty cell)
 * @param {(string | null)[]} newKeys the camera each cell is to show
 * @returns {{ from: number[], unused: number[] }} from[i]: the old cell whose tile goes to cell i,
 *   or -1 (a new tile); unused: old cells whose tiles go (closed)
 */
export function reuseSlots(oldKeys, newKeys) {
  const where = new Map()
  oldKeys.forEach((k, i) => {
    if (k != null && !where.has(k)) where.set(k, i)
  })
  const taken = new Set()
  const from = newKeys.map((k) => {
    const i = k == null ? undefined : where.get(k)
    if (i === undefined || taken.has(i)) return -1
    taken.add(i)
    return i
  })
  return { from, unused: oldKeys.map((_, i) => i).filter((i) => !taken.has(i)) }
}

// ---- where the order starts from, and this browser's copy ----------------------------------------------

/**
 * The state to start with: the server's order and version, with this browser's unsaved changes
 * (if any) to be done again on top of it (never instead of it: it may be newer, from another
 * screen). Server unreachable: this browser's copy stands in; else the default order, version 0.
 * @param {{ server: { order: string[], version: number } | null,
 *   local: { version: number, base: string[], ops: object[] } | null }} from
 * @returns {{ base: { order: string[], version: number }, ops: object[] }}
 */
export function pickStart({ server, local }) {
  if (server) return { base: server, ops: local?.ops ?? [] }
  if (local) return { base: { order: local.base, version: local.version }, ops: local.ops }
  return { base: { order: [], version: 0 }, ops: [] }
}

const localKey = (user) => `cctv.gridOrder:${user}`

/**
 * This browser's copy of the user's order: the server's order and version as last seen, and the
 * changes the server does not have yet. null: none, no storage, or it throws.
 * @returns {{ version: number, base: string[], ops: object[] } | null}
 */
export function readLocal(storage, user) {
  if (!storage || !user) return null
  try {
    const j = JSON.parse(storage.getItem(localKey(user)) ?? 'null')
    if (!j || typeof j !== 'object' || !Array.isArray(j.base)) return null
    return {
      version: Number.isSafeInteger(j.version) && j.version >= 0 ? j.version : 0,
      base: cleanOrder(j.base),
      ops: Array.isArray(j.ops) ? j.ops.filter(isOp).slice(-(MAX_OPS + 1)) : []
    }
  } catch {
    return null
  }
}

/** Keeps a copy of the user's order in this browser (see readLocal). */
export function writeLocal(storage, user, { version, base, ops }) {
  if (!storage || !user) return
  try {
    storage.setItem(localKey(user), JSON.stringify({ version, base, ops }))
  } catch {}
}

// ---- the sync with the server ------------------------------------------------------------------------------

const sameList = (a, b) => a.length === b.length && a.every((k, i) => k === b[i])

/** { order, version } from an answer of the server, or null. */
function stateFrom(body) {
  if (!body || !Array.isArray(body.order) || !Number.isSafeInteger(body.version) || body.version < 0) return null
  return { order: cleanOrder(body.order), version: body.version }
}

/**
 * This user's order on this screen, kept in step with the server and the user's other screens.
 *   load()      reads the order (and this browser's unsaved changes); the grid is built after it
 *   order       the order to show (the server's, with this screen's unsaved changes on top)
 *   change(op)  a change by the user: shown at once (onChange), saved delayMs after the last one
 *   refresh()   every camera-list refresh and when the tab shows again: sends unsaved changes if
 *               any, else re-reads the order and shows it if another screen changed it
 *   flush()     the page is closing: a change waiting to be saved goes out now
 * Saving: one request at a time; a 409 (another screen saved first) brings the newer order, the
 * changes are done again on it and sent again (up to MAX_CONFLICT_TRIES times). A failed save is
 * reported (onFailed), kept in this browser, and sent again with the next change or refresh,
 * never in a loop by itself.
 * @param {{ request: (method: 'GET' | 'PUT', body?: object) => Promise<{ status: number, body: any }>,
 *   cameras: () => object[], storage?: Storage | null, user: () => string | null, delayMs?: number,
 *   onChange?: (order: string[]) => void, onSaved?: () => void, onFailed?: (error: Error) => void,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} opts
 *   request: throws when there is no answer; cameras: every camera, in default order
 */
export function createOrderSync({
  request,
  cameras,
  storage = null,
  user,
  delayMs = 500,
  onChange = () => {},
  onSaved = () => {},
  onFailed = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let base = { order: [], version: 0 } // the server's order as last seen, and its version
  let ops = [] // changes made here on top of base that the server does not have yet
  let timer = null // a save waiting for its delay
  let busy = false // a save on its way
  let again = false // a change came while one was on its way
  let epoch = 0 // counts changes of base: an answer to a GET sent before one is out of date

  const current = () => (ops.length ? applyOps(base.order, ops, cameras()) : [...base.order])
  const keep = () => writeLocal(storage, user(), { version: base.version, base: base.order, ops })
  /** A new base (from the server); the grid is told when the order shown changes. */
  const rebase = (state, remaining = ops) => {
    const before = current()
    base = state
    ops = remaining
    epoch++
    keep()
    const after = current()
    if (!sameList(before, after)) onChange(after)
  }

  const read = async () => {
    try {
      const r = await request('GET')
      return r?.status === 200 ? stateFrom(r.body) : null
    } catch {
      return null
    }
  }

  const send = async () => {
    if (busy) {
      again = true
      return
    }
    if (!ops.length) return
    busy = true
    try {
      for (let tries = 0; ; tries++) {
        const sent = [...ops]
        const r = await request('PUT', { order: cleanOrder(current(), cameras()), version: base.version })
        const state = stateFrom(r?.body)
        if (r?.status === 200 && state) {
          // changes made while it was on its way stay to be sent (all of them if they were folded meanwhile)
          rebase(state, sent.every((op, i) => ops[i] === op) ? ops.slice(sent.length) : ops)
          onSaved()
          break
        }
        if (r?.status === 409 && state && tries < MAX_CONFLICT_TRIES) {
          // another screen saved first: the same changes again, on its order
          rebase(state)
          continue
        }
        throw new Error(r ? `HTTP ${r.status}` : 'no answer')
      }
    } catch (e) {
      onFailed(e)
    }
    busy = false
    if (again) {
      again = false
      await send()
    }
  }

  const fire = () => {
    timer = null
    send()
  }

  return {
    async load() {
      const start = pickStart({ server: await read(), local: readLocal(storage, user()) })
      base = start.base
      ops = start.ops
      epoch++
      keep()
    },
    get order() {
      return current()
    },
    /** Changes the server does not have yet. */
    get unsaved() {
      return ops.length > 0
    },
    /** @returns {boolean} whether the order changed */
    change(op) {
      if (!isOp(op)) return false
      const before = current()
      const after = applyOp(before, op, cameras())
      if (sameList(before, after)) return false
      // a reset (or set) makes the changes before it moot
      if (op.op === 'reset' || op.op === 'set') ops = []
      else if (ops.length >= MAX_OPS) ops = [{ op: 'set', order: cleanOrder(before) }]
      ops.push(op)
      keep()
      onChange(current())
      if (timer !== null) clearTimer(timer)
      timer = setTimer(fire, delayMs)
      return true
    },
    async refresh() {
      if (busy || timer !== null) return // a save is due or on its way: its answer brings the latest order
      if (ops.length) return send()
      const at = epoch
      const state = await read()
      if (!state || at !== epoch || busy || timer !== null || ops.length) return // out of date meanwhile
      if (state.version !== base.version || !sameList(state.order, base.order)) rebase(state)
    },
    flush() {
      if (timer === null) return
      clearTimer(timer)
      timer = null
      send()
    }
  }
}
