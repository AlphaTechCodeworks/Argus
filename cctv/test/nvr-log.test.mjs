// An NVR's own event log, read only (nvr-log.mjs): the request as the NVR's web client builds it,
// the answer parsed, the route. A fake query; no SDK.
//   node cctv/test/nvr-log.test.mjs
import { chOfGuid, handleNvrLog, logRequest, parseLog, parseUtcText, utcText } from '../nvr-log.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const T = Date.UTC(2026, 8, 26, 13, 16, 51)

const req = logRequest({ types: ['LOG_ALARM_INTELLIGENT', 'nonsense'], fromMs: T - 3600_000, toMs: T, page: 2 })
check('the page comes first, then the condition', /<pageIndex>2<\/pageIndex><pageSize>100<\/pageSize><condition>/.test(req))
check('a list of log types (unknown ones left out)', /<logType type="list"><itemType type="logType"\/><item><!\[CDATA\[LOG_ALARM_INTELLIGENT\]\]><\/item><\/logType>/.test(req) && !/nonsense/.test(req), req)
check('times in UTC as the web client sends them', req.includes('<startTime><![CDATA[2026-09-26 12:16:51]]></startTime>') && req.includes('<endTime><![CDATA[2026-09-26 13:16:51]]></endTime>'))
let threw = false
try { logRequest({ types: ['bogus'], fromMs: 0, toMs: 1 }) } catch { threw = true }
check('no known type: refused before asking the NVR', threw)
check('UTC text round trip', parseUtcText(utcText(T)) === T)
check('a channel GUID back to its channel', chOfGuid('{0000001A-0000-0000-0000-000000000000}') === 25 && chOfGuid('garbage') === null)

const answer = `<?xml version="1.0"?><response><status>success</status><content type="list" total="2"><itemType/>
<item><logType>LOG_ALARM_INTELLIGENT</logType><time>2026-09-26 13:00:05</time><userName></userName><clientType>LOCAL</clientType><content>Intrusion</content><chl id="{00000003-0000-0000-0000-000000000000}">PW Exit</chl></item>
<item><logType>LOG_ALARM_MOTION</logType><time>2026-09-26 13:01:00</time><chl id="{0000001A-0000-0000-0000-000000000000}">roadway</chl></item>
</content></response>`
const parsed = parseLog(answer)
check('total and items', parsed.total === 2 && parsed.items.length === 2)
check('an AI alarm: type, time, camera', parsed.items[0].type === 'LOG_ALARM_INTELLIGENT' && parsed.items[0].atMs === Date.UTC(2026, 8, 26, 13, 0, 5) && parsed.items[0].ch === 2 && parsed.items[0].camera === 'PW Exit' && parsed.items[0].content === 'Intrusion')
check('an empty log', parseLog('<response><status>success</status><content type="list" total="0"/></response>').total === 0)

const nvrs = new Map([['n1', { id: 'n1', name: 'NVR 1', online: true }]])
let sent = null
const query = async (nvr, url, xml) => { sent = { url, xml }; return answer }
check('admins only', (await handleNvrLog('GET', '/api/admin/nvrs/n1/log', '', { nvrs, admin: false, query }))[0] === 403)
const r = await handleNvrLog('GET', '/api/admin/nvrs/n1/log', `types=LOG_ALARM_INTELLIGENT&from=${T - 7 * 86_400_000}&to=${T}`, { nvrs, admin: true, query, now: T })
check('the route asks queryLog and answers the items', r[0] === 200 && sent.url === 'queryLog' && r[1].items.length === 2 && /LOG_ALARM_INTELLIGENT/.test(sent.xml))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
