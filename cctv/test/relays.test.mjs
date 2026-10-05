// NVR alarm outputs, read only (relays.mjs): the request, the answer parsed, and the routes, with a
// fake NVR query (no SDK).
//   node cctv/test/relays.test.mjs
import { alarmOutRequest, handleRelays, parseAlarmOuts } from '../relays.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

check('the request is an empty NVMS-9000 request', /<request version="1.0" systemType="NVMS-9000" clientType="WEB"><\/request>$/.test(alarmOutRequest()))
const answer = `<?xml version="1.0" encoding="UTF-8"?><response><status>success</status><content>
  <item id="{00000001-0000-0000-0000-000000000000}"><name>Siren</name><onlineStatus>true</onlineStatus><switch>false</switch><delay>5secs</delay></item>
  <item id="{00000002-0000-0000-0000-000000000000}"><name>Gate</name><onlineStatus>false</onlineStatus><switch>true</switch><delay><enum>manual</enum></delay></item>
</content></response>`
const outs = parseAlarmOuts(answer)
check('two outputs, with their names and ids', outs.length === 2 && outs[0].name === 'Siren' && outs[0].id.startsWith('{00000001'))
check('state and online read', outs[0].on === false && outs[0].online === true && outs[1].on === true && outs[1].online === false)
check('the delay, plain or as an enum', outs[0].delay === '5secs' && outs[1].delay === 'manual', JSON.stringify(outs))
check('an NVR with none: an empty list', parseAlarmOuts('<response><status>success</status><content/></response>').length === 0)
let err = ''
try { parseAlarmOuts('<response><status>fail</status><errorCode>536870953</errorCode></response>') } catch (e) { err = e.message }
check('no alarm rights: said plainly', /no alarm rights/.test(err), err)
try { parseAlarmOuts('not xml') } catch (e) { err = e.message }
check('not a document: said plainly', /did not answer with a document/.test(err), err)

const nvrs = new Map([
  ['n1', { id: 'n1', name: 'NVR 1', online: true }],
  ['n2', { id: 'n2', name: 'NVR 2', online: false }]
])
const asked = []
const query = async (nvr, url, xml) => { asked.push([nvr.id, url]); return answer }
check('not an admin: 403', (await handleRelays('GET', '/api/admin/alarm-outputs', { nvrs, admin: false, query }))[0] === 403)
check('not our path: null', (await handleRelays('GET', '/api/admin/nvrs/n1/disks', { nvrs, admin: true, query })) === null)
check('nothing but reading: a POST is refused', (await handleRelays('POST', '/api/admin/nvrs/n1/alarm-outputs', { nvrs, admin: true, query }))[0] === 405)
const all = await handleRelays('GET', '/api/admin/alarm-outputs', { nvrs, admin: true, query })
check('every NVR: outputs where online, the reason where not', all[0] === 200 && all[1].nvrs[0].outputs.length === 2 && /offline/.test(all[1].nvrs[1].error))
check('an offline NVR is not asked', asked.every(([id]) => id === 'n1') && asked[0][1] === 'getAlarmOutStatus')
const one = await handleRelays('GET', '/api/admin/nvrs/n1/alarm-outputs', { nvrs, admin: true, query })
check('one NVR', one[0] === 200 && one[1].outputs[1].name === 'Gate')
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
