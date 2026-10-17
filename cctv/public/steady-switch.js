// "Steady picture" for one camera (admins), at the top of the camera editor's Picture tab on the Sites
// page (camera-editor.js). One switch: on, the server steadies the camera's live picture for everyone
// watching it (steady.mjs); off, the camera's own picture again. Saved at once, no Save button: a
// change moves the camera's live viewers over within a second or two, the preview beside it included.
//   GET  /api/admin/steady                 -> { cameras: [{ nvr, ch, by, at }], running, cap }
//   POST /api/admin/steady { nvr, ch, on } -> { nvr, ch, on, changed }
// The words are exported for node tests (steadyWords).

export const STEADY_LABEL = 'Steady picture'
export const STEADY_HELP = 'Steadies a shaking picture (a camera on a pole in the wind, for example) for everyone watching this camera live. While it is on, the camera is shown at standard quality only, not full quality. Recordings are not changed.'

/**
 * The line under the switch, from what the server says.
 * @param {{ on: boolean, cap: number, saved?: boolean, error?: string }} o
 *   saved: just changed here; error: the save failed (its reason)
 */
export function steadyWords({ on, cap, saved = false, error = '' }) {
  if (error) return `Not saved: ${error}`
  if (!(cap > 0)) return 'Steady picture is turned off on this server.'
  if (saved) return on ? 'On. Everyone watching this camera live gets the steadied picture within a few seconds.' : 'Off. The camera’s own picture again, within a few seconds.'
  return `The server steadies up to ${cap} camera${cap === 1 ? '' : 's'} at a time; past that a camera plays as it is until there is room.`
}

const STEADY_URL = '/api/admin/steady'

/**
 * The switch for `cam` ({ nvr, ch }), in an element of its own (`el`), filled once the setting is read.
 * @returns {{ el: HTMLElement }}
 */
export function steadySwitch(cam, { fetchFn = (...a) => fetch(...a) } = {}) {
  const el = document.createElement('div')
  el.className = 'steady-switch'
  const label = document.createElement('label')
  label.className = 'steady-row'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.disabled = true
  const name = document.createElement('span')
  name.className = 'steady-name'
  name.textContent = STEADY_LABEL
  label.append(box, name)
  const help = document.createElement('p')
  help.className = 'steady-help'
  help.textContent = STEADY_HELP
  const note = document.createElement('p')
  note.className = 'steady-note'
  note.setAttribute('role', 'status')
  note.textContent = 'Reading…'
  el.append(label, help, note)
  let cap = 0
  const say = (o) => {
    note.textContent = steadyWords({ on: box.checked, cap, ...o })
    note.classList.toggle('steady-error', Boolean(o?.error))
  }
  fetchFn(STEADY_URL, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the server answered ${r.status}`))))
    .then((d) => {
      cap = Number(d?.cap) || 0
      box.checked = Array.isArray(d?.cameras) && d.cameras.some((c) => c.nvr === cam.nvr && c.ch === cam.ch)
      box.disabled = !(cap > 0) && !box.checked
      say()
    })
    .catch((e) => {
      note.textContent = `Could not read the setting: ${e?.message ?? e}`
      note.classList.add('steady-error')
    })
  box.addEventListener('change', async () => {
    const on = box.checked
    box.disabled = true
    try {
      const r = await fetchFn(STEADY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nvr: cam.nvr, ch: cam.ch, on }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || `the server answered ${r.status}`)
      say({ saved: true })
    } catch (e) {
      box.checked = !on
      say({ error: e?.message ?? String(e) })
    } finally {
      box.disabled = !(cap > 0) && !box.checked
    }
  })
  return { el }
}
