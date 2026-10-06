// The live full-size view is view-only: camera settings now live on Sites
// (camera-editor.js), so viewer.js must not carry the Picture/OSD/Lines panels.
//   node cctv/test/viewer-viewonly.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const src = readFileSync(join(import.meta.dirname, '..', 'public', 'viewer.js'), 'utf8').replace(/\r\n/g, '\n')

check('no Picture/Lines/OSD toggle buttons', !/pic-toggle|lines-toggle|osd-toggle/.test(src))
check('the settings panels are no longer imported', !/image-panel\.js|osd-panel\.js|lines-panel\.js/.test(src))
check('no panel singletons remain', !/\bimagePanel\b|\blinesPanel\b|\bosdPanel\b/.test(src))
check('no shownPlayer/waitForMain/linesSupported helpers remain', !/\bshownPlayer\b|\bwaitForMain\b|\blinesSupported\b/.test(src))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
