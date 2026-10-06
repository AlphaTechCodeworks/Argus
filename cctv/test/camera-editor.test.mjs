// Pins down the Sites camera editor's wiring without a browser: it re-hosts the
// three panels beside one main-stream preview, one active at a time. (The sites.js
// side of the wiring is checked at the bottom once Task 3 lands.)
//   node cctv/test/camera-editor.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const read = (f) => readFileSync(join(import.meta.dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n')

const ed = read('camera-editor.js')
check('exports openCameraEditor', /export function openCameraEditor\(/.test(ed))
check('imports the three panels', /from '\.\/image-panel\.js'/.test(ed) && /from '\.\/osd-panel\.js'/.test(ed) && /from '\.\/lines-panel\.js'/.test(ed))
check('preview is a main-stream LiveTile built from TILE_HTML', /TILE_HTML/.test(ed) && /new LiveTile\(tileEl, cam, MAIN_STREAM\)/.test(ed))
check('Picture panel gets getPlayer + waitForMain', /new ImagePanel\(\{ getPlayer, waitForMain \}\)/.test(ed))
check('OSD and Lines overlay the preview via liveEl', /new OsdPanel\(osdBody, cam, \{ liveEl/.test(ed) && /new LinesPanel\(linesBody, cam, \{ liveEl/.test(ed))
check('switching tabs guards unsent changes', /if \(!confirmDiscard\(\)\) return/.test(ed))
check('Lines tab hidden until the NVR supports line crossing', /linesSupported\(cam\)\.then/.test(ed))
check('close tears down the preview and the editor DOM', /preview\.close\(\)/.test(ed) && /root\.remove\(\)/.test(ed))

// Task 3 wiring (sites.js) — enabled once sites.js imports the editor.
const sites = read('sites.js')
if (/camera-editor\.js/.test(sites)) {
  check('sites.js groups cameras per NVR', /camerasForNvr\(/.test(sites))
  check('sites.js fetches the camera list', /\/api\/cameras/.test(sites))
  check('sites.js has a per-NVR Cameras dropdown', /st-cameras/.test(sites))
  check('sites.js keeps one editor at a time, guarded', /confirmDiscard\(\)/.test(sites))
  check('sites.js skips re-render while a dropdown is open', /details\[open\]/.test(sites))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
