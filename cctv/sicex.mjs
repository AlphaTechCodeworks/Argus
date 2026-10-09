// SICE-X: the optional things that make Argus faster to use, switched from one place.
//
// Each of them was built with its own switch in a browser's storage (2026-10-09). This is the
// engine's own: one master switch, one per module, and sites to leave out, kept on the server so
// they hold for every screen, changed by an administrator, and turned off by the engine itself
// when the measurements say it is making things worse.
//
// Nothing here is needed for the platform to work. With the engine off, or this file gone, every
// page does what it did before any of it was built: that is the rule (core ownership), and it is
// why the modules are only ever asked "may I", never relied on.
//
//   data/sicex.json   { enabled, modules: { id: boolean }, sitesOff: [site], auto: { at, why } | null, by, at }
//
//   GET /api/sicex?device=<id>   -> { enabled, modules, sitesOff, cohort, list, auto }   (anyone signed in)
//       modules: what is in effect for THIS browser: all false with the engine off, and all false
//       for the one browser in ten kept as the comparison (telemetry.mjs cohortOf): without screens
//       that really run without it, nothing could say whether it helps
//   PUT /api/admin/sicex { enabled?, modules?, sitesOff? } -> the settings as kept   (administrators)
//       turning the engine on again clears an automatic switch-off
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-write.mjs'

export const SICEX_PATH = '/api/sicex'
export const SICEX_ADMIN_PATH = '/api/admin/sicex'

/** The modules, in the order shown. needs: another module that must be on for it to do anything. */
export const MODULES = Object.freeze([
  { id: 'decoderHold', name: 'Player reserve', what: 'The player holds a little more video when the decoder releases frames late, so fewer are skipped on grids.' },
  { id: 'ahead', name: 'Next camera ahead', what: 'In the full-size view, the next camera\'s full-quality stream is started before it is asked for.' },
  { id: 'hold', name: 'Server stream hold', what: 'The server keeps the next camera\'s full-quality stream running for viewers who cannot start it themselves.' },
  { id: 'linked', name: 'Linked cameras', what: 'One-click buttons to the cameras linked to this one on the map.' },
  { id: 'wallThin', name: 'Wall sharing', what: 'On a wall the screen cannot decode in full, the busiest cameras keep every frame and the rest show a current picture every few seconds.' },
  { id: 'wallProfile', name: 'Layout figures', what: 'How each layout performed on this screen, beside it in the layout picker, with a warning for one it handled badly.' }
])
const IDS = MODULES.map((m) => m.id)
const BODY_LIMIT = 8192
const NO_STORE = { 'cache-control': 'no-store' }
const SITE_RE = /^[^\u0000-\u001f]{1,80}$/

/** The engine's settings as kept, or the start: everything on. */
export const sicexDefaults = () => ({ enabled: true, modules: Object.fromEntries(IDS.map((id) => [id, true])), sitesOff: [], auto: null })

/** Settings from a file or a request, made whole and safe. Unknown modules are dropped, missing ones are on. */
export function cleanSicex(b, base = sicexDefaults()) {
  if (!b || typeof b !== 'object') return null
  const out = { enabled: base.enabled, modules: { ...base.modules }, sitesOff: [...base.sitesOff], auto: base.auto ?? null }
  if ('enabled' in b) { if (typeof b.enabled !== 'boolean') return null; out.enabled = b.enabled }
  if ('modules' in b) {
    if (!b.modules || typeof b.modules !== 'object') return null
    for (const id of IDS) if (id in b.modules) { if (typeof b.modules[id] !== 'boolean') return null; out.modules[id] = b.modules[id] }
  }
  if ('sitesOff' in b) {
    if (!Array.isArray(b.sitesOff) || b.sitesOff.length > 200 || !b.sitesOff.every((s) => typeof s === 'string' && SITE_RE.test(s.trim()))) return null
    out.sitesOff = [...new Set(b.sitesOff.map((s) => s.trim()))].sort()
  }
  if (b.auto && typeof b.auto === 'object' && typeof b.auto.why === 'string') out.auto = { at: String(b.auto.at ?? ''), why: b.auto.why.slice(0, 300) }
  return out
}

/** What is in effect for one browser: nothing with the engine off, nothing for the comparison group. */
export function effective(settings, cohort) {
  const on = settings.enabled && cohort !== 'holdout'
  return Object.fromEntries(IDS.map((id) => [id, on && settings.modules[id] !== false]))
}

/**
 * The engine switches itself off when the screens running it measurably fare worse than the ones
 * kept without it. Deliberately coarse: the whole engine, on a clear margin, with enough of both.
 * @param {{ cohorts?: { apsi?: { score: number | null, tileSeconds: number }, holdout?: { score: number | null, tileSeconds: number } } }} summary telemetry.mjs summary()
 * @returns {string | null} why it should be switched off, or null
 */
export const AUTO = Object.freeze({ minTileSeconds: 3600, margin: 0.05 })
export function autoOffReason(summary, { minTileSeconds = AUTO.minTileSeconds, margin = AUTO.margin } = {}) {
  const on = summary?.cohorts?.apsi
  const off = summary?.cohorts?.holdout
  if (!on || !off || !(on.tileSeconds >= minTileSeconds) || !(off.tileSeconds >= minTileSeconds)) return null
  if (typeof on.score !== 'number' || typeof off.score !== 'number') return null
  if (on.score >= off.score - margin) return null
  const pct = (x) => Math.round(x * 100)
  return `over the last ${summary.hours ?? 24} h the screens with it scored ${pct(on.score)} and the screens without it ${pct(off.score)}`
}

/** @param {{ dir: string, read?: Function, write?: Function, now?: () => number, log?: Function }} o dir: the data folder */
export function makeSicex({ dir, read = readFileSync, write = writeFileAtomicSync, now = Date.now, log = () => {} }) {
  const file = join(dir, 'sicex.json')
  let current = null
  const load = () => {
    if (current) return current
    try {
      current = cleanSicex(JSON.parse(read(file, 'utf8'))) ?? sicexDefaults()
    } catch {
      current = sicexDefaults() // (never set, or unreadable: everything on)
    }
    return current
  }
  const keep = (next, by) => {
    write(file, `${JSON.stringify({ ...next, by: String(by).slice(0, 64), at: new Date(now()).toISOString() }, null, 1)}\n`)
    current = next
    return next
  }
  return {
    get: () => structuredClone(load()),
    /** An administrator's change; null when it is not a valid one (nothing changes). */
    set(change, by = '') {
      const next = cleanSicex(change, load())
      if (!next) return null
      if (next.enabled) next.auto = null // (on again by a person: the automatic switch-off is answered)
      return structuredClone(keep(next, by))
    },
    /** The engine's own switch-off. Returns the reason when it acted, null when there was none or it was off already. */
    autoCheck(summary) {
      const s = load()
      if (!s.enabled) return null
      const why = autoOffReason(summary)
      if (!why) return null
      try {
        keep({ ...s, enabled: false, auto: { at: new Date(now()).toISOString(), why } }, 'sicex')
      } catch (e) {
        log(`[sicex] could not keep the switch-off: ${e?.code ?? e?.message ?? e}`)
        current = { ...s, enabled: false, auto: { at: new Date(now()).toISOString(), why } } // (off in this process all the same)
      }
      log(`[sicex] SWITCHED ITSELF OFF: ${why}. An administrator can turn it on again on the Health page.`)
      return why
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

/** The two routes; null when the path is neither. cohortOf: telemetry.mjs's (user, device) -> 'apsi' | 'holdout'. */
export async function handleSicex(req, pathname, { user, admin, store, cohortOf, device = '', log = () => {} }) {
  const view = (s, cohort) => ({ enabled: s.enabled, modules: effective(s, cohort), set: s.modules, sitesOff: s.sitesOff, cohort, auto: s.auto, list: MODULES })
  if (pathname === SICEX_PATH) {
    if (!user) return [401, { error: 'Sign in' }, NO_STORE]
    if (req.method !== 'GET') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'GET' }]
    const dev = /^[a-z0-9]{6,32}$/i.test(device) ? device : ''
    return [200, view(store.get(), dev ? cohortOf(user, dev) : 'apsi'), NO_STORE]
  }
  if (pathname !== SICEX_ADMIN_PATH) return null
  if (!user) return [401, { error: 'Sign in' }, NO_STORE]
  if (admin !== true) return [403, { error: 'Admins only' }, NO_STORE]
  if (req.method !== 'PUT') return [405, { error: 'Method not allowed' }, { ...NO_STORE, allow: 'PUT' }]
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return [415, { error: 'JSON only' }, NO_STORE]
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
  if (!saved) return [400, { error: 'Not a valid SICE-X setting' }, NO_STORE]
  const off = IDS.filter((id) => saved.modules[id] === false)
  log(`[sicex] ${user} set the engine ${saved.enabled ? 'on' : 'OFF'}${off.length ? `, modules off: ${off.join(', ')}` : ''}${saved.sitesOff.length ? `, sites left out: ${saved.sitesOff.join(', ')}` : ''}`)
  return [200, view(saved, 'apsi'), NO_STORE]
}
