// The Sites camera dropdown groups /api/cameras by NVR, in channel order
// (camera-choice.js camerasForNvr, beside the Alarms picker's cameraGroups).
//   node cctv/test/sites-cameras.test.mjs
import { camerasForNvr, cameraLabel } from '../public/camera-choice.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const cams = [
  { nvr: 'a', ch: 5, name: 'Gate', online: true },
  { nvr: 'b', ch: 1, name: 'Yard', online: true },
  { nvr: 'a', ch: 2, name: 'Dock', online: false }
]
const a = camerasForNvr(cams, 'a')
check('only that NVR, in channel order', a.map((c) => c.ch).join(',') === '2,5', a.map((c) => c.ch).join(','))
check('labels come from cameraLabel', cameraLabel(a[0]) === '3 · Dock', cameraLabel(a[0]))
check('does not mutate the input order', cams[0].ch === 5)
check('unknown NVR -> empty', camerasForNvr(cams, 'z').length === 0)
check('missing list -> empty', camerasForNvr(undefined, 'a').length === 0)
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
