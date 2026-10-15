// Tests for find-device.mjs (the Sites page's "Find device") and the page's words (public/find-device.js).
// The data below has the shapes of prod (2026-10-15): the Cameras report with ch numbered from 0 and
// mac null for every camera, LAN and P2P recorders, PoE cameras on 10.151.151.x at many recorders,
// P2P sites whose cameras sit in the server's own 192.168.0.0/22, and /proc/net/arp as Linux writes it.
// SDK-free, no network; runs anywhere.
//   node cctv/test/find-device.test.mjs
import { buildIndex, classifyQuery, findDevice, localNets, makeFindDevice, normaliseMac, onLocalNet, parseArp, sweepNets } from '../find-device.mjs'
import { foundByText, lookedText, openTarget, rowText } from '../public/find-device.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- fixtures (prod shapes) ----

const ARP = `IP address       HW type     Flags       HW address            Mask     Device
192.168.2.152    0x1         0x2         90:2e:16:7f:f3:f6     *        ens34
192.168.0.226    0x1         0x2         58:5b:69:00:d7:3c     *        ens34
192.168.1.121    0x1         0x0         00:00:00:00:00:00     *        ens34
192.168.2.24     0x1         0x2         00:18:ae:bc:fd:5f     *        ens34
192.168.0.228    0x1         0x2         58:5b:69:00:d6:d7     *        ens34
192.168.1.60     0x1         0x2         e4:54:e8:ae:55:c0     *        ens34
192.168.1.150    0x1         0x2         a4:bb:6d:7d:8b:1d     *        ens34
`
const IFACES = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
  ens34: [{ family: 'IPv4', address: '192.168.1.232', cidr: '192.168.1.232/22', internal: false }, { family: 'IPv6', address: 'fe80::1', cidr: 'fe80::1/64', internal: false }],
  tailscale0: [{ family: 'IPv4', address: '100.114.214.72', cidr: '100.114.214.72/32', internal: false }]
}
const nets = localNets(IFACES)

const recorders = [
  { id: 'nvr1', name: 'Lawrence', site: 'Lawrence', host: '192.168.0.228', port: 6036, sn: null, via: 'lan', online: true, model: 'NVR-63432-16P-AI-S2', channels: [] },
  { id: 'solus', name: 'Solus', site: 'IT Office', host: '192.168.2.24', port: 6036, sn: null, via: 'lan', online: true, model: 'NVR-63108-8P-N2', channels: [] },
  { id: 'marine-satety', name: 'Marine Satety', site: 'Marine Satety', host: 'cli-nat20.eyeincloud.com', port: 9969, sn: 'NB8AF056T0D2', via: 'p2p', online: true, model: 'NVR6216-P16-V3', channels: [] },
  // a LAN recorder with a camera on the server's own network (none on prod today; the rule must hold)
  { id: 'office', name: 'Office NVR', site: 'IT Office', host: '192.168.2.30', port: 6036, sn: null, via: 'lan', online: true, model: '', channels: [
    { ch: 0, name: 'Server Room', online: true, ip: '192.168.1.150', model: 'IPC672', maker: 'TVT', httpPort: 80 }
  ] }
]
const cam = (ch, name, ip, extra = {}) => ({ ch, name, online: true, ip, model: 'IP6798W-28-4K-SI-AI', maker: 'TVT', mac: null, uid: null, camId: null, httpPort: null, dataPort: 9008, poe: false, ...extra })
const report = {
  at: Date.UTC(2026, 9, 14, 6, 0),
  nvrs: [
    { nvr: 'nvr1', nvrName: 'Lawrence', site: 'Lawrence', via: 'lan', nvrModel: 'NVR-63432-16P-AI-S2', nvrOnline: true, cameras: [
      cam(0, 'PW Exit', '192.168.10.40'), cam(1, 'Wharf OB West', '192.168.10.43'), cam(12, 'North Gate', '192.168.35.114', { poe: true })
    ] },
    { nvr: 'solus', nvrName: 'Solus', site: 'IT Office', via: 'lan', nvrModel: 'NVR-63108-8P-N2', nvrOnline: true, cameras: [
      cam(3, 'Eyeonet', '10.151.151.105', { poe: true })
    ] },
    { nvr: 'marine-satety', nvrName: 'Marine Satety', site: 'Marine Satety', via: 'p2p', nvrModel: 'NVR6216-P16-V3', nvrOnline: true, cameras: [
      cam(3, 'Eyeonet', '10.151.151.105', { poe: true }), cam(7, 'Marine saftey', '192.168.1.60', { model: 'IP619E5W-28-S4', online: false })
    ] },
    // a recorder removed from the app since the report
    { nvr: 'old-nvr', nvrName: 'Old Yard', site: 'Old Yard', via: 'lan', nvrModel: null, nvrOnline: true, cameras: [cam(0, 'Old Gate', '192.168.50.10')] }
  ]
}
const search = [
  { ip: '192.168.0.228', name: 'Lawrence', model: 'NVR-63432-16P-AI-S2', mac: '58:5b:69:00:d6:d7', type: 'NVR', port: 6036 },
  { ip: '192.168.2.31', name: 'IPC', model: 'IPC672LR', mac: '58:5b:69:11:22:33', type: 'IP camera', port: 9008 }
]
const data = { recorders, report, arp: parseArp(ARP), search, nets }
const find = (q, extra = {}) => findDevice(q, { ...data, ...extra })

// ---- MACs, queries, ARP, networks ----

const want = 'aa:bb:cc:dd:ee:0f'
for (const s of ['aa:bb:cc:dd:ee:0f', 'AA-BB-CC-DD-EE-0F', 'aabb.ccdd.ee0f', 'AABBCCDDEE0F', ' Aa:Bb:cC:dd:EE:0f ', 'aa-bb:cc-dd:ee:0f']) check(`MAC "${s}" normalises`, normaliseMac(s) === want, normaliseMac(s))
for (const s of ['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', 'aa:bb:cc', 'gg:bb:cc:dd:ee:ff', 'aabbccddeeff00', '', null]) check(`"${s}" is not a MAC`, normaliseMac(s) === null)

check('a whole MAC is a MAC query', classifyQuery('58-5B-69-00-D6-D7').kind === 'mac')
check('three pairs are part of a MAC', classifyQuery('58:5B:69').kind === 'mac-part' && classifyQuery('58:5B:69').value === '58:5b:69')
check('a whole address is an address query', classifyQuery('192.168.35.114').kind === 'ip')
check('the start of an address is a prefix', classifyQuery('192.168.35').kind === 'ip-part' && classifyQuery('192.168.35.').value === '192.168.35.')
check('999.1.1.1 is not an address', classifyQuery('999.1.1.1').kind === 'name')
check('a name is a name, lower-cased', classifyQuery('North Gate').kind === 'name' && classifyQuery('North Gate').value === 'north gate')
check('"10" is a name (camera names have numbers)', classifyQuery('10').kind === 'name')
check('one character is refused', Boolean(classifyQuery('a').error))
check('a long query is refused', Boolean(classifyQuery('x'.repeat(65)).error))

const arp = parseArp(ARP)
check('ARP: the header and the incomplete row are left out', arp.length === 6 && !arp.some((a) => a.ip === '192.168.1.121'), arp.length)
check('ARP: MAC and device read', arp.find((a) => a.ip === '192.168.0.228')?.mac === '58:5b:69:00:d6:d7' && arp[0].dev === 'ens34')
check('ARP: rubbish gives nothing', parseArp('garbage\nmore garbage here\n').length === 0 && parseArp(undefined).length === 0)

check('networks: one from ens34, not lo, not the /32', nets.length === 1 && nets[0].cidr === '192.168.1.232/22')
check('192.168.3.24 is on the server’s /22', onLocalNet('192.168.3.24', nets))
check('192.168.10.40 is not', !onLocalNet('192.168.10.40', nets))

// ---- MAC lookups ----

let r = find('58:5b:69:00:d6:d7')
check('MAC of a LAN recorder finds the recorder', r.results.length === 1 && r.results[0].kind === 'recorder' && r.results[0].nvr === 'nvr1', JSON.stringify(r.results.map((x) => x.label)))
check('... with its site and address', r.results[0].site === 'Lawrence' && r.results[0].address === '192.168.0.228')
check('... found in the recorder list, network table and search', ['recorders', 'arp', 'search'].every((s) => r.results[0].sources.includes(s)), r.results[0].sources.join())
check('the Cisco way of writing it finds the same', find('585b.6900.d6d7').results[0]?.nvr === 'nvr1')
r = find('00-18-AE-BC-FD-5F')
check('MAC of Solus (network table only) finds Solus', r.results[0]?.nvr === 'solus' && r.results[0].mac === '00:18:ae:bc:fd:5f')
r = find('58:5b:69')
check('part of a MAC (a maker’s prefix) finds every device with it', r.kind === 'mac-part' && r.results.length === 3 && r.results[0].nvr === 'nvr1' && r.results.some((x) => x.kind === 'device' && x.ip === '192.168.2.31') && r.results.some((x) => x.kind === 'device' && x.ip === '192.168.0.226'), r.results.map((x) => x.label).join())
r = find('de:ad:be:ef:00:01')
check('an unknown MAC: nothing, and the PoE-MAC limit is said', r.results.length === 0 && r.notes.some((n) => /PoE/.test(n) && /web page/.test(n)))
r = find('a4:bb:6d:7d:8b:1d')
check('a camera on the server’s own network gets its MAC from the network table', r.results.length === 1 && r.results[0].kind === 'camera' && r.results[0].nvr === 'office' && r.results[0].ch === 0, JSON.stringify(r.results[0]))
check('... and no note about a missing MAC', r.results[0].note === null)

// ---- address lookups ----

r = find('192.168.35.114')
check('a PoE camera’s address finds it', r.results.length === 1 && r.results[0].label === 'Camera 13 · North Gate' && r.results[0].nvrName === 'Lawrence')
check('... its MAC is unknown and the note says why (PoE, on site or its web page)', r.results[0].mac === null && /PoE/.test(r.results[0].note) && /web page/.test(r.results[0].note))
check('... found in the Cameras report', r.results[0].sources.includes('report'))
r = find('10.151.151.105')
check('the same PoE address at two recorders: both, and a note that they differ', r.results.length === 2 && r.notes.some((n) => /2 recorders/.test(n) && /different cameras/.test(n)), r.notes.join(' | '))
r = find('192.168.1.60')
const p2pCam = r.results.find((x) => x.kind === 'camera')
const lanDev = r.results.find((x) => x.kind === 'device')
check('a P2P site’s camera inside the server’s range is not given the office device’s MAC', p2pCam && p2pCam.nvr === 'marine-satety' && p2pCam.mac === null && p2pCam.online === false)
check('... the office device is listed on its own, with its MAC', lanDev && lanDev.mac === 'e4:54:e8:ae:55:c0' && lanDev.sources.join() === 'arp')
check('... and a note says they are different devices', r.notes.some((n) => /not that camera/.test(n)))
check('... the P2P camera’s note says on site or its web page', /P2P/.test(p2pCam.note) && /web page/.test(p2pCam.note))
r = find('192.168.10.')
check('the start of an address lists those cameras', r.kind === 'ip-part' && r.results.length === 2 && r.results.every((x) => x.ip.startsWith('192.168.10.')))
r = find('192.168.2.31')
check('a TVT camera that only the network search saw', r.results.length === 1 && r.results[0].kind === 'device' && r.results[0].type === 'IP camera' && r.results[0].mac === '58:5b:69:11:22:33' && /TVT camera/.test(r.results[0].note))
r = find('192.168.2.31', { search: [] })
check('without that search it is not known', r.results.length === 0 && r.notes.length === 1)

// ---- names ----

r = find('north gate')
check('names match whatever the case', r.results.length === 1 && r.results[0].ch === 12)
r = find('Lawrence')
check('a recorder’s name: the recorder first, then its cameras', r.results[0].kind === 'recorder' && r.results.length === 4 && r.results.slice(1).every((x) => x.kind === 'camera' && x.nvr === 'nvr1'), r.results.map((x) => x.label).join(' | '))
r = find('it office')
check('a site’s name finds its recorders and cameras', r.results.some((x) => x.nvr === 'solus' && x.kind === 'recorder') && r.results.some((x) => x.nvr === 'office' && x.kind === 'camera'))
r = find('old gate')
check('a camera of a recorder removed since the report is still placed', r.results[0]?.nvrName === 'Old Yard' && r.results[0].site === 'Old Yard')
r = findDevice('Eyeonet', data, { max: 1 })
check('output is bounded, and the rest counted', r.results.length === 1 && r.more === 1)
r = find('server room', { report: null })
check('no report yet: the live lists still answer', r.results.length === 1 && r.results[0].sources.includes('live') && !r.results[0].sources.includes('report'))
r = find('nothing like this')
check('nothing matches: an explanation with the MAC limit', r.results.length === 0 && r.notes.some((n) => /web page/.test(n)))
check('a P2P recorder’s address is its serial', find('marine satety').results[0].address === 'P2P cloud, serial NB8AF056T0D2')

// ---- the index itself ----

const idx = buildIndex(data)
check('one entry per camera, report and live merged', idx.filter((e) => e.kind === 'camera' && e.nvr === 'office').length === 1)
check('the report’s recorder model fills a live recorder without one', idx.find((e) => e.kind === 'recorder' && e.nvr === 'nvr1').model === 'NVR-63432-16P-AI-S2')
check('a search reply with junk is cleaned', buildIndex({ search: [{ ip: '192.168.1.9', mac: 'aa:bb:cc:dd:ee:01', name: 'x\u0007y<' }] , nets })[0].name === 'xy<')
check('a search reply that is not an address is dropped', buildIndex({ search: [{ ip: '<script>' }], nets }).length === 0)

// ---- the route ----

let searches = 0
let t = 1_000_000
const handler = makeFindDevice({
  recorders: () => recorders,
  report: () => report,
  arp: () => ({ ok: true, rows: parseArp(ARP) }),
  nets: () => nets,
  search: async () => { searches++; return { ran: true, devices: search } },
  now: () => t
})
const params = (q) => new URLSearchParams(q)
let [status, body] = await handler('POST', params('q=north'))
check('POST is refused', status === 405)
;[status, body] = await handler('GET', params('q=x'))
check('a one-letter query is a 400 with words', status === 400 && /2 characters/.test(body.error))
;[status, body] = await handler('GET', params('q=192.168.2.31'))
check('without &search=1 no search runs, and none is known yet', status === 200 && searches === 0 && body.results.length === 0 && body.looked.search === null)
check('looked: the report’s time and counts, the live lists, the network table', body.looked.report.at === report.at && body.looked.report.cameras === 7 && body.looked.report.recorders === 4 && body.looked.live.cameras === 1 && body.looked.arp.devices === 6)
;[status, body] = await handler('GET', params('q=192.168.2.31&search=1'))
check('&search=1 runs the network search and finds the camera', searches === 1 && body.results[0]?.type === 'IP camera' && body.looked.search.ran && body.looked.search.now)
t += 5000
;[status, body] = await handler('GET', params('q=58:5b:69&search=1'))
check('a second search within 15 s reuses the first', searches === 1 && body.results.length === 3)
t += 10 * 60_000
;[status, body] = await handler('GET', params('q=192.168.2.31'))
check('the last search is still used (and named) for a while without &search=1', searches === 1 && body.results.length === 1 && body.looked.search.now === false)
t += 2 * 3600_000
;[status, body] = await handler('GET', params('q=192.168.2.31'))
check('... but not hours later', body.results.length === 0 && body.looked.search === null)
t += 11_000
let limited = 0
for (let i = 0; i < 25; i++) if ((await handler('GET', params('q=north')))[0] === 429) limited++
check('more than 20 lookups in 10 s are refused', limited === 5, limited)
t += 11_000
check('... and allowed again after', (await handler('GET', params('q=north')))[0] === 200)

const failing = makeFindDevice({ recorders: () => [], report: () => null, arp: () => ({ ok: false, rows: [], why: 'only available when the server runs on Linux' }), nets: () => [], search: async () => { throw new Error('UDP port 23456 is in use') } })
;[status, body] = await failing('GET', params('q=camera&search=1'))
check('a search that throws is reported, not a 500', status === 200 && body.looked.search.ran === false && /23456/.test(body.looked.search.why))
check('no report and no network table are said', body.looked.report === null && body.looked.arp.ok === false)

// ---- the page's words ----

const looked = { report: { at: report.at, recorders: 4, cameras: 7 }, live: { recorders: 4, cameras: 1 }, arp: { ok: true, devices: 6 }, search: null }
check('found by: one source', foundByText(['arp'], looked) === 'the server’s network table')
check('found by: report with its time, then the network table', /^the Cameras report of .+ and the server’s network table$/.test(foundByText(['arp', 'report'], looked)), foundByText(['arp', 'report'], looked))
const lt = lookedText(looked)
check('looked: report, live lists, network table and no search', /Cameras report of .*7 cameras on 4 recorders/.test(lt) && /6 devices/.test(lt) && /no network search/.test(lt), lt)
check('looked: no report and a failed search are said plainly', /no Cameras report yet/.test(lookedText({ ...looked, report: null, search: { ran: false, why: 'port in use', at: 1 } })) && /did not run \(port in use\)/.test(lookedText({ ...looked, search: { ran: false, why: 'port in use', at: 1 } })))
const camRow = find('192.168.35.114').results[0]
const rt = rowText(camRow)
check('camera row: title, place, facts', rt.title === 'Camera 13 · North Gate' && rt.place === 'Lawrence · its recorder' && /address 192\.168\.35\.114 · MAC not known · .*on a PoE port · online/.test(rt.facts), `${rt.place} | ${rt.facts}`)
const recRow = find('58:5b:69:00:d6:d7').results[0]
check('recorder row: connected, MAC shown', /MAC 58:5b:69:00:d6:d7/.test(rowText(recRow).facts) && rowText(recRow).status === 'connected' && rowText(recRow).title === 'Recorder Lawrence')
check('camera opens full size in Live', openTarget(camRow).href === '/?nvr=nvr1&ch=12')
check('recorder shows on the Sites page', openTarget(recRow).nvr === 'nvr1' && !openTarget(recRow).href)
check('a loose device has nothing to open', openTarget(find('192.168.2.31').results[0]) === null)

// ---- discovery: the owner's own network only, every address knocked on first ----
{
  check('"*" is the whole list', classifyQuery('*').kind === 'all')
  const all = findDevice('*', {
    recorders: [
      { id: 'nvr1', name: 'Lawrence', site: 'Lawrence', host: '192.168.0.228', via: 'lan', online: true, channels: [{ ch: 12, name: 'North Gate', ip: '192.168.35.114', online: true }] },
      { id: 'shad', name: 'Shad', site: 'Shad', sn: 'N123', via: 'p2p', online: true, channels: [{ ch: 0, name: 'Gate', ip: '10.0.0.5', online: true }] }
    ],
    arp: [{ ip: '192.168.2.31', mac: 'aa:bb:cc:dd:ee:ff', dev: 'ens34' }],
    nets: [{ net: (192 * 16777216 + 168 * 65536) >>> 0, mask: 0xfffffc00, address: '192.168.1.232' }]
  }, { max: 2000 })
  const sites = new Set(all.results.map((r) => r.site ?? r.kind))
  check('the discovery list leaves out P2P sites', !all.results.some((r) => r.nvr === 'shad') && all.results.some((r) => r.nvr === 'nvr1'), JSON.stringify([...sites]))
  check('... and lists the network\'s own devices', all.results.some((r) => r.kind === 'device' && r.ip === '192.168.2.31'))
  const seen = []
  const fake = (o) => {
    seen.push(o.host)
    return { on: (ev, f) => ev === 'error' && setTimeout(f, 1), setTimeout() {}, destroy() {} }
  }
  const n = await sweepNets([{ net: (192 * 16777216 + 168 * 65536) >>> 0, mask: 0xfffffc00, address: '192.168.1.232' }], { open: fake })
  check('the sweep knocks on every address of a /22 but the server\'s own', n === 1021 && seen[0] === '192.168.0.1' && seen.at(-1) === '192.168.3.254' && !seen.includes('192.168.1.232'), `${n}`)
  check('... and never on a network too big to sweep', (await sweepNets([{ net: 0x0a000000, mask: 0xff000000, address: '10.0.0.1' }], { open: fake })) === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
