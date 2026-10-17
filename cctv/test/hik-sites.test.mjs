// Hikvision on the Sites page and in Discover devices:
//   - a Hikvision device answering ONVIF is recognised (onvif-discovery.mjs makerOf), listed when it is
//     not in Argus yet with an "Add" that fills in the dialog (find-device.mjs brand, find-device.js
//     addTarget), and not listed once added;
//   - the Add/Edit dialog's wording: the make, Hikvision's port, the Test button, Hik-Connect off and
//     labelled until Hikvision's developer values are there (source checks: the page needs a browser).
//   node cctv/test/hik-sites.test.mjs
import { readFileSync } from 'node:fs'
import { findDevice } from '../find-device.mjs'
import { makerOf, parseProbeMatch } from '../onvif-discovery.mjs'
import { addTarget } from '../public/find-device.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- ONVIF ----
const match = (scopes) => `<e:Envelope><e:Body><d:ProbeMatches><d:ProbeMatch><d:Scopes>${scopes}</d:Scopes><d:XAddrs>http://192.168.1.64/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>`
const hikCam = parseProbeMatch(match('onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/HIKVISION%20DS-2CD2143G2-I onvif://www.onvif.org/hardware/DS-2CD2143G2-I'), '192.168.1.64')
check('a Hikvision camera: maker Hikvision, an IP camera', hikCam.maker === 'Hikvision' && hikCam.type === 'IP camera' && hikCam.model === 'DS-2CD2143G2-I')
const hikNvr = parseProbeMatch(match('onvif://www.onvif.org/name/Network_Video_Recorder onvif://www.onvif.org/hardware/DS-7608NI-K2'), '192.168.1.70')
check('a Hikvision recorder by its DS- model: maker Hikvision, an NVR', hikNvr.maker === 'Hikvision' && hikNvr.type === 'NVR')
const tvt = parseProbeMatch(match('onvif://www.onvif.org/name/IPC onvif://www.onvif.org/hardware/IP619E5W-28-S4'), '192.168.2.118')
check('a TVT camera: no maker claimed', tvt.maker === null)
check('makerOf: iDS- models too; nothing for others', makerOf('', 'iDS-2CD7A46G0') === 'Hikvision' && makerOf('onvif://www.onvif.org/name/Dahua', 'IPC-HFW') === null)

// ---- Discover devices ----
const search = [
  { ip: '192.168.1.64', name: 'HIKVISION DS-2CD2143G2-I', model: 'DS-2CD2143G2-I', type: 'IP camera', maker: 'Hikvision' },
  { ip: '192.168.1.70', name: '', model: 'DS-7608NI-K2', type: 'NVR', maker: 'Hikvision' },
  { ip: '192.168.2.118', name: '', model: 'IP619E5W-28-S4', type: 'IP camera' }
]
const nets = [{ net: (192 << 24 | 168 << 16 | 1 << 8) >>> 0, mask: 0xffffff00 }, { net: (192 << 24 | 168 << 16 | 2 << 8) >>> 0, mask: 0xffffff00 }]
let r = findDevice('*', { recorders: [], search, nets }, { max: 100 })
const cam = r.results.find((x) => x.ip === '192.168.1.64')
const nvr = r.results.find((x) => x.ip === '192.168.1.70')
check('both Hikvision devices are listed, marked brand hikvision', cam?.brand === 'hikvision' && nvr?.brand === 'hikvision')
check('... with the maker in the model, and a note saying how it is added', /^Hikvision DS-2CD2143G2-I$/.test(cam.model ?? '') && /Hikvision camera/.test(cam.note) && /Hikvision recorder/.test(nvr.note) && /port 8000/.test(nvr.note), cam.model)
check('a TVT device is not marked Hikvision', r.results.find((x) => x.ip === '192.168.2.118')?.brand === null)
check('Add fills in: Hikvision, its address, port 8000, its name', JSON.stringify(addTarget(cam)) === JSON.stringify({ brand: 'hikvision', host: '192.168.1.64', port: 8000, name: 'HIKVISION DS-2CD2143G2-I' }))
check('Add for a nameless recorder: named by its model', addTarget(nvr)?.name === 'Hikvision DS-7608NI-K2' || addTarget(nvr)?.name === 'DS-7608NI-K2', addTarget(nvr)?.name)
check('no Add for a TVT device or for something already in Argus', addTarget(r.results.find((x) => x.ip === '192.168.2.118')) === null && addTarget({ kind: 'recorder', brand: 'hikvision', ip: '1.2.3.4' }) === null)
// once added (a recorder at that address), it is no longer offered
r = findDevice('*', { recorders: [{ id: 'yard', name: 'Yard', site: 'Yard', host: '192.168.1.70', port: 8000, via: 'lan', online: true, channels: [] }], search, nets }, { max: 100 })
check('a Hikvision recorder already added is not listed again', !r.results.some((x) => x.ip === '192.168.1.70'))

// ---- the dialog ----
const html = readFileSync(new URL('../public/sites.html', import.meta.url), 'utf8')
const js = readFileSync(new URL('../public/sites.js', import.meta.url), 'utf8')
const fd = readFileSync(new URL('../public/find-device.js', import.meta.url), 'utf8')
check('a Make choice: TVT (checked) or Hikvision', /id="f-brand-tvt" value="tvt" checked/.test(html) && /id="f-brand-hik" value="hikvision"/.test(html) && /<legend>Make<\/legend>/.test(html))
check('Hikvision uses port 8000 by default (6036 stays TVT\'s)', /const HIK_PORT = 8000/.test(js) && /const TVT_PORT = 6036/.test(js))
check('a Test button (Hikvision), hidden until Hikvision is chosen; it posts to /api/admin/nvr-test', /<button type="button" id="test" hidden>Test<\/button>/.test(html) && /\/api\/admin\/nvr-test/.test(js) && /\$\('test'\)\.hidden = !hik/.test(js))
check('Test reports model, serial and cameras', /Logged in: \$\{r\.model/.test(js) && /serial \$\{r\.serial\}/.test(js) && /camera\$\{r\.cameras === 1/.test(js))
check('Hik-Connect: offered, off and disabled at first', /<summary>Connect through Hik-Connect \(P2P\)<\/summary>/.test(html) && /<input id="f-hp-on" type="checkbox" disabled \/>/.test(html))
check('Hik-Connect: labelled with the developer-access words until set up', html.includes('Off — needs Hik-Connect developer access (AppID and server addresses from Hikvision).') && js.includes('Off — needs Hik-Connect developer access (AppID and server addresses from Hikvision).'))
check('Hik-Connect: account (email or phone) and password; Advanced: AppID, sign-in server, platform address, platform type', /Hik-Connect account \(email or phone number\)/.test(html) && /Hik-Connect password/.test(html) && /Advanced: developer access from Hikvision/.test(html) && /AppID/.test(html) && /Sign-in server address/.test(html) && /Platform address/.test(html) && /Platform type/.test(html))
check('Hik-Connect: secrets are password fields, shown only as "not set" / "set"', ['f-hp-password', 'f-hp-appid', 'f-hp-auth', 'f-hp-platform'].every((id) => new RegExp(`id="${id}" type="password"`).test(html)) && /<small id="f-hp-appid-hint">not set<\/small>/.test(html))
check('Hik-Connect: no address or AppID is filled in by the page (no defaults)', !/f-hp-(auth|platform|appid)['"]\)\.value = ['"][^'"]/.test(js) && !/hik-connect\.com|ezviz|hikvision\.com/i.test(html + js))
check('Hik-Connect: the page says it is unverified', /Unverified: Hik-Connect sign-in has not been tried/.test(html))
check('the make of a saved recorder cannot be changed in Edit', /\$\(id\)\.disabled = Boolean\(nvr\)/.test(js))
check('Sub-streams (TVT settings) is not offered for a Hikvision device', /n\.status === 'online' && n\.brand !== 'hikvision'/.test(js))
check('Discover devices: Add opens the dialog filled in', /addDevice: \(prefill\) => openForm\(null, prefill\)/.test(js) && /addDevice\(add\)/.test(fd))
check('a Hikvision device found shows "Hikvision" in its place line', /n\.brand === 'hikvision' \? 'Hikvision · '/.test(js))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
