// The Alarms page camera picker (public/camera-choice.js): grouped by site, "3 · North Gate",
// offline last or left out. The flat list it replaced: 73 entries, a dozen just "Eyeonet".
//   node cctv/test/camera-choice.test.mjs
import { cameraGroups, cameraLabel } from '../public/camera-choice.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const cams = [
  { nvr: 'nvr1', nvrName: 'NVR 1', site: 'Main site', ch: 2, name: 'Eyeonet', online: true },
  { nvr: 'nvr1', nvrName: 'NVR 1', site: 'Main site', ch: 13, name: 'North Gate', online: true },
  { nvr: 'solus', nvrName: 'Solus', site: 'IT Office', ch: 4, name: 'Eyeonet', online: true },
  { nvr: 'solus', nvrName: 'Solus', site: 'IT Office', ch: 7, name: '', online: false },
  { nvr: 'yard1', nvrName: 'Yard A', site: 'Yard', ch: 0, name: 'Gate', online: true },
  { nvr: 'yard2', nvrName: 'Yard B', site: 'Yard', ch: 0, name: 'Gate', online: true }
]
check('a camera reads "channel · name"', cameraLabel(cams[1]) === '14 · North Gate')
check('an unnamed camera: "channel · Camera channel"', cameraLabel(cams[3]) === '8 · Camera 8')
const g = cameraGroups(cams)
check('one group per site, in the server order, offline last', g.map((x) => x.label).join('|') === 'Main site|IT Office|Yard · Yard A|Yard · Yard B|Offline', g.map((x) => x.label).join('|'))
check('two "Eyeonet"s are told apart by site and channel', g[0].items[0].label === '3 · Eyeonet' && g[1].items[0].label === '5 · Eyeonet')
check('a site with two NVRs: a group each (channel numbers would repeat)', g[2].items[0].value === 'yard1/0' && g[3].items[0].value === 'yard2/0')
check('offline cameras say where they are', g[4].items[0].label === 'IT Office · 8 · Camera 8' && g[4].items[0].value === 'solus/7')
check('onlineOnly: no Offline group', !cameraGroups(cams, { onlineOnly: true }).some((x) => x.label === 'Offline'))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
