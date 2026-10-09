// What counts as an acceptable wall, as the administrator says.
//
// The Live page measures the share of arriving frames each screen draws and calls it fine, below
// recommended or poor (public/wall-profile.js). Where those lines fall is the administrator's to
// say, not the code's (the owner's rule, 2026-10-09: administrator tolerance over hard-coded
// limits). One pair of figures for the whole system, kept in the data folder:
//
//   data/wall-tolerance.json   { okShare, poorShare, by, at }
//
//   GET /api/wall-tolerance          -> { okShare, poorShare, defaults }      (anyone signed in)
//   PUT /api/admin/wall-tolerance    { okShare, poorShare } -> the same        (administrators)
//
// okShare: a wall drawing at least this share of its frames is fine; poorShare: below this it is
// poor; between the two it is "below recommended". Nothing here stops anyone using a layout.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-write.mjs'

export const TOLERANCE_PATH = '/api/wall-tolerance'
export const TOLERANCE_ADMIN_PATH = '/api/admin/wall-tolerance'
/** The owner's defaults: up to 20% of frames dropped is fine, over 30% is poor. */
export const DEFAULTS = Object.freeze({ okShare: 0.8, poorShare: 0.7 })
const BODY_LIMIT = 4096
const NO_STORE = { 'cache-control': 'no-store' }

/** A pair as sent, made safe: null when it is not one (fine must be above poor, both sensible shares). */
export function cleanTolerance(b) {
  const ok = Number(b?.okShare)
  const poor = Number(b?.poorShare)
  if (!Number.isFinite(ok) || !Number.isFinite(poor)) return null
  if (ok > 1 || ok < 0.3 || poor < 0.1 || poor >= ok) return null
  return { okShare: Math.round(ok * 100) / 100, poorShare: Math.round(poor * 100) / 100 }
}

/**
 * @param {{ dir: string, read?: Function, write?: Function, now?: () => number }} o dir: the data folder
 */
export function makeTolerance({ dir, read = readFileSync, write = writeFileAtomicSync, now = Date.now }) {
  const file = join(dir, 'wall-tolerance.json')
  let current = null
  const load = () => {
    if (current) return current
    try {
      current = cleanTolerance(JSON.parse(read(file, 'utf8'))) ?? { ...DEFAULTS }
    } catch {
      current = { ...DEFAULTS } // (never set, or unreadable: the defaults)
    }
    return current
  }
  return {
    get: () => ({ ...load() }),
    /** Keeps a new pair; returns it, or null when it is not a valid one (nothing changes). */
    set(pair, by = '') {
      const clean = cleanTolerance(pair)
      if (!clean) return null
      write(file, `${JSON.stringify({ ...clean, by: String(by).slice(0, 64), at: new Date(now()).toISOString() }, null, 1)}\n`)
      current = clean
      return { ...clean }
    }
  }
}

async function bodyOf(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > BODY_LIMIT) return undefined
    chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** The two routes; null when the path is neither. */
export async function handleTolerance(req, pathname, { user, admin, store, log = () => {} }) {
  if (pathname === TOLERANCE_PATH) {
    if (!user) return [401, { error: 'Sign in' }, NO_STORE]
    if (req.method !== 'GET') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'GET' }]
    return [200, { ...store.get(), defaults: { ...DEFAULTS } }, NO_STORE]
  }
  if (pathname !== TOLERANCE_ADMIN_PATH) return null
  if (!user) return [401, { error: 'Sign in' }, NO_STORE]
  if (admin !== true) return [403, { error: 'Admins only' }, NO_STORE]
  if (req.method !== 'PUT') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'PUT' }]
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return [415, { error: 'JSON only' }, NO_STORE]
  // a page of this site only: another site's script must not change it with an admin's session
  const origin = req.headers.origin
  let from = null
  try { from = origin ? new URL(origin).host : null } catch { from = '' }
  if (origin && from !== req.headers.host) return [403, { error: 'Wrong origin' }, NO_STORE]
  let saved = null
  try {
    saved = store.set(await bodyOf(req), user)
  } catch (e) {
    return [500, { error: `Could not keep it: ${e?.code ?? e?.message ?? e}` }, NO_STORE]
  }
  if (!saved) return [400, { error: 'Fine must be above poor, and both between 10% and 100%' }, NO_STORE]
  log(`[wall] ${user} set the wall tolerance: fine from ${Math.round(saved.okShare * 100)}%, poor below ${Math.round(saved.poorShare * 100)}%`)
  return [200, { ...saved, defaults: { ...DEFAULTS } }, NO_STORE]
}
