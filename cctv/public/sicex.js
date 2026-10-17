// What SICE-X allows in this browser (sicex.mjs on the server: the master switch, a switch per
// module, sites left out, and the one browser in ten kept without it as the comparison).
//
// Every optional thing asks here before it acts: sicexOn('wallThin'), sicexOn('linked', cam.site).
// Until the server has answered, what it said last time is used (kept in this browser), and
// everything is allowed where it has never been asked: a server without the engine's route, or one
// that cannot be reached, leaves the page exactly as it was before there was a switch.
//
// No top-level await here, by rule (test/no-shared-await.test.mjs): this is imported by more than one page script.
const KEY = 'argus.sicex'
let state // undefined: not looked yet; null: nothing known (all allowed); else { modules, sitesOff }

function kept() {
  try {
    const j = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null')
    return j && j.modules && typeof j.modules === 'object' ? { modules: j.modules, sitesOff: Array.isArray(j.sitesOff) ? j.sitesOff : [] } : null
  } catch {
    return null
  }
}

/** Whether a module may act, here, for a camera of this site (site left out: for the whole page). */
export function sicexOn(id, site) {
  if (state === undefined) state = kept()
  if (!state) return true
  if (state.modules[id] === false) return false
  return !(site && state.sitesOff.includes(site))
}

/** Tells the page what the server says (also for tests). null: nothing known, everything allowed. */
export function setSicex(s) {
  state = s && s.modules && typeof s.modules === 'object' ? { modules: s.modules, sitesOff: Array.isArray(s.sitesOff) ? s.sitesOff : [] } : null
  try {
    if (state) globalThis.localStorage?.setItem(KEY, JSON.stringify(state))
    else globalThis.localStorage?.removeItem(KEY)
  } catch {}
}

/**
 * Asks the server once. device: this browser's own random name (telemetry.js deviceId), which is
 * what the comparison group is drawn by.
 * @returns {Promise<object | null>} the server's answer, or null (no such route, or no answer: as before)
 */
export async function loadSicex(device = '') {
  try {
    const r = await fetch(`/api/sicex?device=${encodeURIComponent(device)}`)
    if (r.status === 404) {
      setSicex(null) // (a server without the engine: nothing is switched)
      return null
    }
    if (!r.ok) return null
    const j = await r.json()
    setSicex(j)
    return j
  } catch {
    return null
  }
}
