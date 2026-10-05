// An NVR's network status, read only (nvr-netstatus.mjs): the request, the answer parsed with its units,
// the cache, and the route, with a fake NVR query (no SDK).
//   node cctv/test/nvr-netstatus.test.mjs
import { readFileSync } from 'node:fs'
import { CACHE_MS, handleNetStatus, netStatusRequest, parseNetStatus, readNetStatus, toMbps } from '../nvr-netstatus.mjs'
import { XML_HEADER } from '../xml.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const threw = (fn) => { try { fn(); return '' } catch (e) { return e.message || 'threw' } }

// ---- the request ----
check('the request is exactly the empty NVMS-9000 read request', netStatusRequest() === `${XML_HEADER}</request>`, netStatusRequest())

// ---- units ----
check('a bare number is Mbit/s', toMbps('192') === 192 && toMbps(' 71 ') === 71)
check('as the NVR\'s page writes them: 192Mb, 71Mb', toMbps('192Mb') === 192 && toMbps('71Mb') === 71 && toMbps('99 Mb') === 99)
check('unit="MB" is megabits, not megabytes (the firmware\'s label is wrong)', toMbps('192', 'MB') === 192 && toMbps('192MB') === 192)
check('Mbps, Mbit/s, M', toMbps('10Mbps') === 10 && toMbps('10 Mbit/s') === 10 && toMbps('10M') === 10)
check('kbit/s in the text or the attribute is scaled down', toMbps('512kbps') === 0.512 && toMbps('104960', 'Kb') === 104.96 && toMbps('2048 kbit/s') === 2.048)
check('G scaled up', toMbps('1Gbps') === 1000 && toMbps('1.5', 'Gb') === 1500)
check('a text unit wins over the attribute', toMbps('64kbps', 'MB') === 0.064)
check('an attribute that is no known unit is ignored', toMbps('192', 'furlongs') === 192)
check('nothing, garbage, a negative or an unknown written unit: null', [toMbps(''), toMbps(undefined), toMbps('n/a'), toMbps('-5'), toMbps('5 furlongs'), toMbps('1,024')].every((v) => v === null))

// ---- the answer ----
// Built from what is known: the bandwidth elements as recorded from nvr-2 (unit="MB" and all), the
// figures from its Network Status page (192/99/192/71), ipGroup and nic/item/ip|ipV6 from the web
// client's parsing. <mac> and <pppoePassword> stand in for the port elements nobody has seen yet.
const answer = `<?xml version="1.0" encoding="UTF-8"?>
<response><status>success</status><content>
  <ipGroup><switch>false</switch><ip></ip><ipV6></ipV6></ipGroup>
  <nic type="list"><itemType/>
    <item id="{00000001-0000-0000-0000-000000000000}"><ip>192.168.0.226</ip><ipV6>fe80::ffff:192:168:2:200</ipV6><mac>58:5B:69:00:D7:3C</mac><dns><item>192.168.0.19</item><item>208.67.222.222</item></dns></item>
    <item><ip>192.168.10.240</ip><ipV6>fe80::ffff:192:168:4:200</ipV6><pppoePassword>hunter2</pppoePassword></item>
  </nic>
  <bandwidth><totalBandwidth unit="MB">192</totalBandwidth><remainBandwidth unit="MB">99</remainBandwidth><sendTotalBandwidth unit="MB">192</sendTotalBandwidth><sendRemainBandwidth unit="MB">71</sendRemainBandwidth></bandwidth>
</content></response>`
const ns = parseNetStatus(answer, { camerasOnline: 25 })
check('receive budget: 192 total, 99 left, 93 in use', ns.totalMbps === 192 && ns.remainMbps === 99 && ns.usedMbps === 93, JSON.stringify(ns))
check('send budget: 192 total, 71 left, 121 in use', ns.sendTotalMbps === 192 && ns.sendRemainMbps === 71 && ns.sendUsedMbps === 121)
check('no note when every figure is there', !('note' in ns))
check('one port per nic item, with its addresses', ns.ports.length === 2 && ns.ports[0].port === 1 && ns.ports[0].ip === '192.168.0.226' && ns.ports[1].ipV6 === 'fe80::ffff:192:168:4:200')
check('a port\'s other elements pass through by the NVR\'s names', ns.ports[0].fields.mac === '58:5B:69:00:D7:3C' && ns.ports[0].fields['dns.item'] === '192.168.0.19' && ns.ports[0].fields['dns.item[2]'] === '208.67.222.222', JSON.stringify(ns.ports[0].fields))
check('... but never anything secret-looking, and not ip/ipV6 twice', !('pppoePassword' in ns.ports[1].fields) && !JSON.stringify(ns).includes('hunter2') && !('ip' in ns.ports[0].fields))
check('the address group, off', ns.ipGroup?.on === false && ns.ipGroup.ip === null)

const figures = (t, r, st, sr, attrs = '') => `<response><status>success</status><content><bandwidth><totalBandwidth${attrs}>${t}</totalBandwidth><remainBandwidth${attrs}>${r}</remainBandwidth><sendTotalBandwidth${attrs}>${st}</sendTotalBandwidth><sendRemainBandwidth${attrs}>${sr}</sendRemainBandwidth></bandwidth></content></response>`
const kb = parseNetStatus(figures('196608', '101376', '196608', '72704', ' unit="Kb"'))
check('an answer in kbit/s comes out in Mbit/s', kb.totalMbps === 196.608 && kb.remainMbps === 101.376 && kb.sendUsedMbps === 123.904, JSON.stringify(kb))
const unfilled = parseNetStatus(figures(192, 192, 192, 184), { camerasOnline: 11 })
check('all receive free with cameras online: unknown, and said why (fw 1.4.6)', unfilled.usedMbps === null && unfilled.remainMbps === 192 && /11 cameras online/.test(unfilled.note ?? ''), JSON.stringify(unfilled))
check('... its send counter is still taken as it comes', unfilled.sendUsedMbps === 8)
check('all free with no camera online: really 0', parseNetStatus(figures(80, 80, 80, 80)).usedMbps === 0)
check('remain above total (a glitch): 0 in use, not negative', parseNetStatus(figures(192, 200, 192, 71)).usedMbps === 0)
const bare = parseNetStatus('<response><status>success</status><content><nic/></content></response>')
check('no bandwidth element: nulls and a note, not an error', bare.totalMbps === null && bare.sendUsedMbps === null && /no bandwidth/.test(bare.note ?? '') && bare.ports.length === 0 && bare.ipGroup === null)

// ---- answers that are not a status ----
let err = threw(() => parseNetStatus('<response><status>fail</status><errorCode>536870947</errorCode></response>'))
check('a refusal throws with its status and code', /refused queryNetStatus \(fail, code 536870947\)/.test(err), err)
err = threw(() => parseNetStatus('<response><status>fail</status><errorCode>536870953</errorCode></response>'))
check('no rights: said plainly', /no rights/.test(err), err)
err = threw(() => parseNetStatus('not xml'))
check('not a document: said plainly', /did not answer with a document/.test(err), err)
err = threw(() => parseNetStatus('<response><status>success</status></response>'))
check('success with no content: an error, not an empty status', /no network status/.test(err), err)
err = threw(() => parseNetStatus('<response><status>success<content></response>'))
check('broken XML: an error', err !== '', err)

// ---- the route ----
const sent = [] // every command any test below sends
const fake = (reply) => async (nvr, url, xml, tag, opts) => {
  sent.push({ nvr: nvr.id, url, xml, tag, opts })
  if (reply instanceof Error) throw reply
  return typeof reply === 'function' ? reply() : reply
}
const mkNvrs = () => new Map([
  ['n1', { id: 'n1', name: 'NVR 1', online: true, gen: 7, channels: [{ ch: 0, online: true }, { ch: 1, online: false }] }],
  ['nvr 2', { id: 'nvr 2', name: 'NVR 2', online: true, gen: 1, channels: [] }],
  ['off', { id: 'off', name: 'Old NVR', online: false }],
  ['busy', { id: 'busy', name: 'Busy NVR', online: true, degraded: true }]
])
let nvrs = mkNvrs()
const P = (id) => `/api/admin/nvrs/${id}/netstatus`
let before = sent.length
check('not our path: null', (await handleNetStatus('GET', '/api/admin/nvrs/n1/alarm-outputs', { nvrs, admin: true, query: fake(answer) })) === null)
check('not a sub-path either', (await handleNetStatus('GET', `${P('n1')}/x`, { nvrs, admin: true, query: fake(answer) })) === null)
check('not an admin: 403', (await handleNetStatus('GET', P('n1'), { nvrs, admin: false, query: fake(answer) }))[0] === 403)
check('... even for a method it would refuse', (await handleNetStatus('POST', P('n1'), { nvrs, admin: false, query: fake(answer) }))[0] === 403)
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  check(`nothing but reading: ${method} is 405`, (await handleNetStatus(method, P('n1'), { nvrs, admin: true, query: fake(answer) }))[0] === 405)
}
check('unknown NVR: 404', (await handleNetStatus('GET', P('nope'), { nvrs, admin: true, query: fake(answer) }))[0] === 404)
check('a broken %-escape: 404, not a crash', (await handleNetStatus('GET', P('%E0%A4%A'), { nvrs, admin: true, query: fake(answer) }))[0] === 404)
const off = await handleNetStatus('GET', P('off'), { nvrs, admin: true, query: fake(answer) })
check('offline: 409, said plainly', off[0] === 409 && /Old NVR is offline/.test(off[1].error))
check('busy recovering: 409', (await handleNetStatus('GET', P('busy'), { nvrs, admin: true, query: fake(answer) }))[0] === 409)
check('none of those asked the NVR anything', sent.length === before, JSON.stringify(sent.slice(before)))

let T = 1_000_000
const clock = () => T
const ok = await handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: fake(answer), clock })
check('200 with the figures and when they were read', ok[0] === 200 && ok[1].sendUsedMbps === 121 && ok[1].usedMbps === 93 && ok[1].at === T && ok[1].ports.length === 2, JSON.stringify(ok))
const one = sent.at(-1)
check('it sent exactly the read request', one.url === 'queryNetStatus' && one.xml === `${XML_HEADER}</request>` && one.tag === 'network status', JSON.stringify(one))
check('... on the session the NVR has now', one.opts?.gen === 7)
const spaced = await handleNetStatus('GET', P('nvr%202'), { nvrs, admin: true, query: fake(answer), clock })
check('an id with an escaped space', spaced[0] === 200 && sent.at(-1).nvr === 'nvr 2')

// the cache: the NVR takes ~1.2 s to answer, so one answer serves everyone for CACHE_MS
before = sent.length
T += CACHE_MS - 1
const again = await handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: fake(answer), clock })
check('asked again within CACHE_MS: the same answer, the NVR not asked', again[0] === 200 && again[1].at === 1_000_000 && sent.length === before)
T += 1
const later = await handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: fake(figures(192, 150, 192, 20)), clock })
check('after CACHE_MS: asked again, the new figures', later[1].sendRemainMbps === 20 && later[1].at === T && sent.length === before + 1)

// two admins at once: one query
nvrs = mkNvrs()
let release
const slow = fake(() => new Promise((r) => (release = () => r(answer))))
before = sent.length
const a = handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: slow, clock })
const b = handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: slow, clock })
await new Promise((r) => setTimeout(r, 10))
release()
const [ra, rb] = await Promise.all([a, b])
check('two at once share one query', sent.length === before + 1 && ra[0] === 200 && rb[0] === 200 && ra[1] === rb[1])

// errors
nvrs = mkNvrs()
const refused = await handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: fake('<response><status>fail</status><errorCode>536870947</errorCode></response>'), clock })
check('the NVR\'s refusal: 502 with its error', refused[0] === 502 && /refused queryNetStatus/.test(refused[1].error), JSON.stringify(refused))
const failed = await handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: fake(new Error('the NVR did not accept the request (error 12)')), clock })
check('the call failing: 502 with its error', failed[0] === 502 && /error 12/.test(failed[1].error))
check('a failure is not kept: the next request asks again', (await handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: fake(answer), clock }))[0] === 200)
nvrs = mkNvrs()
const busy = Object.assign(new Error('Too many NVR settings requests at once (10 waiting); nothing was sent. Try again shortly'), { status: 503, extra: { retryAfterS: 5 } })
const full = await handleNetStatus('GET', P('n1'), { nvrs, admin: true, query: fake(busy), clock })
check('the XML queue full (nothing sent): 503 with the retry hint kept', full[0] === 503 && full[1].retryAfterS === 5 && /nothing was sent/.test(full[1].error), JSON.stringify(full))

// a direct read, as another module would use it
const direct = await readNetStatus({ id: 'd', name: 'D', online: true, gen: 3, channels: [{ ch: 0, online: true }] }, fake(figures(192, 192, 192, 190)), clock)
check('readNetStatus alone: the unfilled-counter check counts the NVR\'s online cameras', direct.usedMbps === null && /1 camera online/.test(direct.note ?? ''), JSON.stringify(direct))

// ---- server.mjs wiring (it loads the SDK, so it is read as text here) ----
{
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const at = src.indexOf('await handleNetStatus(req.method, pathname, { nvrs, admin: who.admin, query: transparent })')
  check('server.mjs imports the module', /import \{ handleNetStatus \} from '\.\/nvr-netstatus\.mjs'/.test(src))
  check('server.mjs dispatches it with the real XML query and the caller\'s admin flag', at > 0 && /if \(netStatus\) return sendJson\(res, \.\.\.netStatus\)/.test(src))
  check('... before the general admin block and admin.mjs (which would answer the path first)', at > 0 && at < src.indexOf("if (pathname.startsWith('/api/admin/'))"))
}

// ---- read only, all the way through ----
check('every command sent in this whole test was queryNetStatus and nothing else', sent.length > 0 && sent.every((s) => s.url === 'queryNetStatus'), [...new Set(sent.map((s) => s.url))].join())
check('no edit or set command, and no body beyond the empty request', sent.every((s) => !/^(edit|set|modify|delete|add)/i.test(s.url) && s.xml === `${XML_HEADER}</request>`))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
