// Offline tests for nvr-online.mjs: the fixtures are the exact shapes g-port answered with over P2P
// on 2026-10-05. No SDK, no network.  node cctv/test/nvr-online.test.mjs
import { chOfGuid, parseOnlineChlList, parseRecStatus } from '../nvr-online.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const guid = (n) => `{${n.toString(16).toUpperCase().padStart(8, '0')}-0000-0000-0000-000000000000}`

// ---- the channel GUID -> 0-based channel mapping ----
check('GUID {00000001} is channel 0', chOfGuid(guid(1)) === 0)
check('GUID {00000003} is channel 2 (g-port Main Gate StreetV)', chOfGuid(guid(3)) === 2)
check('GUID {00000010} is channel 15 (g-port Main Gate)', chOfGuid(guid(16)) === 15)
check('a non-GUID is null', chOfGuid('') === null && chOfGuid('nope') === null && chOfGuid(null) === null)

// ---- queryOnlineChlList ----
{
  const ONLINE = `<?xml version="1.0"?><response cmdUrl="queryOnlineChlList"><status>success</status><content type="list">${[3, 5, 9, 10, 13, 14, 15, 16].map((n) => `<item id="${guid(n)}"></item>`).join('')}</content></response>`
  const set = parseOnlineChlList(ONLINE)
  check('online set has the 8 g-port channels (0-based)', set && set.size === 8 && [2, 4, 8, 9, 12, 13, 14, 15].every((c) => set.has(c)), set && [...set].join(','))
  check('a camera the NVR did not list is offline', !set.has(0) && !set.has(3) && !set.has(5))
  check('an empty online list is a real (empty) set, not null', parseOnlineChlList('<?xml?><response cmdUrl="queryOnlineChlList"><status>success</status><content type="list"></content></response>')?.size === 0)
  check('a non-success answer is null (keep what we had)', parseOnlineChlList('<?xml?><response><status>fail</status><errorCode>5</errorCode></response>') === null)
  check('junk is null, never a throw', parseOnlineChlList('not xml at all') === null)
}

// ---- queryRecStatus (resolution + recording state) ----
{
  const REC = `<?xml version="1.0"?><response cmdUrl="queryRecStatus"><status>success</status><content type="list">` +
    `<item><chl id="${guid(1)}">Northwest</chl><streamType></streamType><recStatus>abnormal</recStatus></item>` +
    `<item><chl id="${guid(3)}">Main Gate StreetV</chl><streamType>main</streamType><resolution>2560x1440</resolution><frameRate>30</frameRate><recStatus>on</recStatus></item>` +
    `<item><chl id="${guid(3)}">Main Gate StreetV</chl><streamType>sub</streamType><resolution>704x480</resolution><frameRate>30</frameRate><recStatus>on</recStatus></item>` +
    `</content></response>`
  const m = parseRecStatus(REC)
  check('rec status parses two channels', m && m.size === 2)
  check('an abnormal channel is read as abnormal', m.get(0)?.recStatus === 'abnormal' && m.get(0)?.name === 'Northwest')
  check('main resolution + fps parse', m.get(2)?.main?.resolution === '2560x1440' && m.get(2).main.w === 2560 && m.get(2).main.h === 1440 && m.get(2).main.fps === 30)
  check('sub resolution parses', m.get(2)?.sub?.resolution === '704x480' && m.get(2).sub.w === 704)
  check('the recording channel reads as on (main wins)', m.get(2)?.recStatus === 'on')
  check('a non-success answer is null', parseRecStatus('<?xml?><response><status>fail</status></response>') === null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
