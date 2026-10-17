// cctv/test/onvif-discovery.test.mjs
// The ONVIF Probe and its answers (onvif-discovery.mjs), and how Discover devices takes them
// (find-device.mjs): an IP camera on the network that Argus does not have is listed; a recorder Argus
// has over P2P that also answers on the network is not.
//   node cctv/test/onvif-discovery.test.mjs
import { parseProbeMatch, probeMessage, wsDiscover } from '../onvif-discovery.mjs'
import { findDevice } from '../find-device.mjs'
let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const probe = probeMessage('1234')
check('the Probe asks for network video devices, with its id', probe.includes('dn:NetworkVideoTransmitter') && probe.includes('uuid:1234') && probe.includes('/discovery/Probe'))

const match = (hardware, name, xaddr) => `<?xml version="1.0"?><SOAP-ENV:Envelope><SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch><d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/hardware/${hardware} onvif://www.onvif.org/name/${name}</d:Scopes><d:XAddrs>${xaddr}</d:XAddrs></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`
const cam = parseProbeMatch(match('IP619E5W-28-S4', 'IP619E5W-28-S4', 'http://192.168.2.118:80/onvif/device_service'), '192.168.2.118')
check('a camera\'s answer: its address, model and port, as an IP camera', cam.ip === '192.168.2.118' && cam.model === 'IP619E5W-28-S4' && cam.type === 'IP camera' && cam.port === 80 && cam.name === '', JSON.stringify(cam))
const nvr = parseProbeMatch(match('NVR-63432-16P-AI-S2', 'Alan%20NVR', 'http://192.168.0.226:8080/onvif/device_service'), '192.168.0.226')
check('a recorder\'s answer is a recorder, its name decoded, its port read', nvr.type === 'NVR' && nvr.name === 'Alan NVR' && nvr.port === 8080, JSON.stringify(nvr))
check('anything else is not a device', parseProbeMatch('<Envelope><Hello/></Envelope>', '1.2.3.4') === null)

// a socket that answers with the camera, then lets the wait run out
const fakeSocket = () => {
  const on = {}
  return {
    on: (ev, f) => { on[ev] = f },
    bind: (_p, cb) => { cb(); setTimeout(() => on.message(Buffer.from(match('IP619E5W-28-S4', 'x', 'http://192.168.2.118/onvif')), { address: '192.168.2.118' }), 5) },
    send: () => {},
    close: () => {}
  }
}
const got = await wsDiscover({ waitMs: 50, socket: fakeSocket })
check('wsDiscover gathers the answers', got.ran === true && got.devices.length === 1 && got.devices[0].ip === '192.168.2.118', JSON.stringify(got))

const all = findDevice('*', {
  recorders: [
    { id: 'shad', name: 'Shad', site: 'Shad', sn: 'N1', via: 'p2p', online: true, channels: [] },
    { id: 'nvr-2', name: 'JFL Wharf Alan', site: 'Wharf', host: '192.168.0.226', via: 'lan', online: true, channels: [] }
  ],
  search: [
    { ip: '192.168.10.201', mac: '00:18:ae:bb:b8:aa', name: 'Shad', model: 'NVR6216-P16-V3', type: 'NVR' },
    { ip: '192.168.0.226', mac: '58:5b:69:00:d7:3c', name: 'Alan NVR', model: 'NVR-63432-16P-AI-S2', type: 'NVR' },
    { ip: '192.168.2.118', mac: null, name: '', model: 'IP619E5W-28-S4', type: 'IP camera' }
  ],
  nets: [{ net: (192 * 16777216 + 168 * 65536) >>> 0, mask: 0xfffffc00, address: '192.168.1.232' }]
}, { max: 2000 })
const ips = all.results.map((r) => r.ip)
check('Discover: the IP camera not in Argus is listed', ips.includes('192.168.2.118'), JSON.stringify(ips))
check('... the recorder Argus has on the network is not', !ips.includes('192.168.0.226'))
check('... nor the one it has over P2P that answers by the same name', !ips.includes('192.168.10.201'))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
