// "Steady picture" on the pages: the tile's mark and its words (public/live-tile.js), the tile taking the
// server's note, the admin's switch and its words (public/steady-switch.js), and where the switch sits
// (the camera editor's Picture tab). Stand-ins for the page and WebSocket; no server.
//   node cctv/test/steady-ui.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// ---- stand-ins (as live-tile.test.mjs)
globalThis.window = { devicePixelRatio: 1 }
globalThis.requestAnimationFrame = () => 1
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.location = { protocol: 'http:', host: 'x' }
const sockets = []
globalThis.WebSocket = class {
  constructor(url) { this.url = url; this.readyState = 0; this.closed = false; sockets.push(this) }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.onclose?.() }
}
WebSocket.OPEN = 1
const el = () => ({ textContent: '', classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) }, contains(c) { return this.set.has(c) } }, append() {} })
const canvas = { width: 0, height: 0, getContext: () => ({}) }
const parts = { '.status': el(), '.stats': el(), '.name': el(), '.dot': { className: '', title: '' }, canvas }
const tileEl = { querySelector: (s) => parts[s], append() {} }

const { LiveTile, MAIN_STREAM, SUB_STREAM, STEADY_BUSY_TEXT, STEADY_TITLE, steadyBadge } = await import('../public/live-tile.js')
const { STEADY_HELP, STEADY_LABEL, steadyWords } = await import('../public/steady-switch.js')

// ---- the mark
{
  const full = steadyBadge('on', MAIN_STREAM)
  check('full size, steadied: "Steady picture", saying full quality is not available', full.text === 'Steady picture' && full.title === STEADY_TITLE && /Full quality is not available/.test(full.title) && full.paused === false)
  check('a grid tile, steadied: short, the words in its title', steadyBadge('on', SUB_STREAM).text === 'STEADY' && steadyBadge('on', SUB_STREAM).title === STEADY_TITLE)
  const busy = steadyBadge('busy', MAIN_STREAM)
  check('past the cap, full size: "Steady picture paused: the server is busy"', busy.text === 'Steady picture paused: the server is busy' && busy.text === STEADY_BUSY_TEXT && busy.paused === true && /comes back by itself/.test(busy.title))
  check('... a grid tile: short, the same words in its title', steadyBadge('busy', SUB_STREAM).text === 'STEADY PAUSED' && steadyBadge('busy', SUB_STREAM).title.startsWith(STEADY_BUSY_TEXT))
  check('failed: paused, in its own words', /could not steady/.test(steadyBadge('failed', MAIN_STREAM).text))
  check('not steadied: no mark', steadyBadge(null, MAIN_STREAM) === null && steadyBadge('nonsense', SUB_STREAM) === null)
}

// ---- the tile takes the server's note, and forgets it on a new connection
{
  const t = new LiveTile(tileEl, { nvr: 'n1', ch: 3 }, MAIN_STREAM)
  t.connect()
  const ws = sockets.at(-1)
  ws.onmessage({ data: JSON.stringify({ op: 'steady', on: true }) })
  check('{"op":"steady","on":true}: steadied', t.steady === 'on')
  ws.onmessage({ data: JSON.stringify({ op: 'steady', on: false, why: 'busy' }) })
  check('{"op":"steady","on":false,"why":"busy"}: paused, busy', t.steady === 'busy')
  ws.onmessage({ data: JSON.stringify({ op: 'steady', on: false, why: 'failed' }) })
  check('... "failed": paused, failed', t.steady === 'failed')
  t.connect()
  check('a new connection: nothing said yet, no mark', t.steady === null)
  check('the note is not taken for a wait note (the status is left alone)', !/wait/i.test(parts['.status'].textContent))
  t.close?.()
}

// ---- the switch's words
check('the switch: "Steady picture", in plain words', STEADY_LABEL === 'Steady picture' && /shaking picture/.test(STEADY_HELP) && /standard quality only/.test(STEADY_HELP) && /Recordings are not changed/.test(STEADY_HELP))
check('read: how many the server steadies at once', steadyWords({ on: false, cap: 4 }) === 'The server steadies up to 4 cameras at a time; past that a camera plays as it is until there is room.' && /up to 1 camera at/.test(steadyWords({ on: true, cap: 1 })))
check('saved on / off: what happens now', /^On\. Everyone watching/.test(steadyWords({ on: true, cap: 4, saved: true })) && /^Off\. The camera/.test(steadyWords({ on: false, cap: 4, saved: true })))
check('a save that failed: said, with why', steadyWords({ on: true, cap: 4, error: 'Only admins can manage NVRs and sites' }) === 'Not saved: Only admins can manage NVRs and sites')
check('the feature off on the server: said', steadyWords({ on: false, cap: 0 }) === 'Steady picture is turned off on this server.')

// ---- where it sits
const read = (f) => readFileSync(join(import.meta.dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n')
const ed = read('camera-editor.js')
check('the camera editor puts the switch at the top of its Picture tab', /import \{ steadySwitch \} from '\.\/steady-switch\.js'/.test(ed) && /picBody\.append\(steadySwitch\(cam\)\.el\)/.test(ed))
const sw = read('steady-switch.js')
check('the switch saves through the admin route as JSON', /'\/api\/admin\/steady'/.test(sw) && /'content-type': 'application\/json'/.test(sw) && /method: 'POST'/.test(sw))
const css = read('css/components.css')
check('its styles are in css/ (tokens only: css-tokens.test.mjs)', /\.steady-switch \{/.test(css) && /\.steady-note\.steady-error \{ color: var\(--bad\)/.test(css))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
