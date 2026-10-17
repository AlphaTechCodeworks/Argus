// Offline tests for a sub-stream's picture size (the Picture tab's "Grid size" picker): what is
// planned for the camera, what may be asked of the POST, and what is refused. No NVR, nothing sent.
// Kept apart from substreams.test.mjs because that one reads lab captures that are not in the
// repository; this one carries its own small answer in the NVR's format, so it runs anywhere.
//   node cctv/test/substreams-res.test.mjs
import { _test } from '../substreams.mjs'

const { parseEncodeInfo, planRes, buildEdit, validate, requestOf, requireOffered, chNumber } = _test
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// one camera as queryNetworkNodeEncodeInfo answers: 704x480 at 20 fps, H.265 VBR 512 kbps, keyframe every 2 s
const ID = '{00000003-0000-0000-0000-000000000000}'
const caps = (enct) =>
  `<item enct="${enct}" res="352x240" digitalDefault="128" analogDefault="128">64,128,256</item>` +
  `<item enct="${enct}" res="704x480" digitalDefault="512" analogDefault="512">64,128,256,512,768</item>` +
  `<item enct="${enct}" res="1280x720" digitalDefault="1024" analogDefault="1024">256,512,1024,2048</item>` +
  `<item enct="${enct}" res="1920x1080" digitalDefault="2048" analogDefault="2048">1024,2048</item>`
const answer =
  '<?xml version="1.0" encoding="UTF-8"?><response><status>success</status><content type="list">' +
  `<item id="${ID}"><name>Yard</name><chlType>digital</chlType>` +
  '<subCaps supEnct="h264,h265" bitType="CBR,VBR"><res fps="30">352x240</res><res fps="30">704x480</res><res fps="25">1280x720</res><res fps="15">1920x1080</res></subCaps>' +
  '<sub res="704x480" fps="20" QoI="512" bitType="VBR" level="higher" enct="h265" GOP="40"></sub>' +
  `<subStreamQualityCaps>${caps('h264')}${caps('h265')}</subStreamQualityCaps>` +
  '</item></content></response>'
const info = parseEncodeInfo(answer)
const yard = info.channels[0]
check('parses the answer: the sizes the camera offers, each with its most frames a second', info.status === 'success' && chNumber(yard.id) === 3 && yard.resolutions.map((r) => `${r.value}@${r.fps}`).join() === '352x240@30,704x480@30,1280x720@25,1920x1080@15' && yard.sub.res === '704x480')

const passes = (ch, sub) => {
  try {
    validate(ch, sub)
    return true
  } catch {
    return false
  }
}
const kept = (plan, keys) => keys.every((k) => plan.sub[k] === yard.sub[k])

// what is planned
const up = planRes(yard, '1280x720')
check('bigger: only the size changes when the camera offers the same rate and bitrate there', up.ok && up.sub.res === '1280x720' && kept(up, ['enct', 'fps', 'QoI', 'bitType', 'level', 'GOP']), JSON.stringify(up.sub))
check('  it passes the checks on what is sent, in the web client\'s own document', passes(yard, up.sub) && buildEdit(yard.id, up.sub).endsWith(`<item id="${ID}"><sub  res="1280x720" fps="20" QoI="512"  bitType="VBR" level="higher" enct="h265"  GOP="40"></sub></item></content></request>`), buildEdit(yard.id, up.sub))
const top = planRes(yard, '1920x1080')
check('a size that goes no faster takes its most (20 → 15 fps), the keyframe spacing kept in seconds (GOP 40 → 30)', top.ok && top.sub.fps === '15' && top.sub.GOP === '30' && passes(yard, top.sub), JSON.stringify(top.sub))
check('  bitrate not offered at the new size: the nearest figure at or above it (512 → 1024)', top.sub.QoI === '1024' && kept(top, ['enct', 'bitType', 'level']))
const small = planRes(yard, '352x240')
check('  ... and where every figure is lower, the top one (512 → 256)', small.ok && small.sub.QoI === '256' && small.sub.fps === '20' && small.sub.GOP === '40' && passes(yard, small.sub), JSON.stringify(small.sub))
const noList = planRes({ ...yard, qualityCaps: [] }, '1280x720')
check('  ... and with no list from the NVR the figure is kept', noList.ok && noList.sub.QoI === '512')
const bare = planRes({ ...yard, sub: { ...yard.sub, GOP: '', bitType: '' } }, '1280x720')
check('an empty GOP or bitrate type is filled as the web client does (4 × fps, CBR)', bare.ok && bare.sub.GOP === '80' && bare.sub.bitType === 'CBR')
check('the codec is never changed by a size', [up, top, small].every((p) => p.sub.enct === 'h265'))
check('the channel as read is not altered by planning', yard.sub.res === '704x480' && yard.sub.fps === '20' && yard.sub.QoI === '512')

// what is not planned
check('the size in use: nothing to do', !planRes(yard, '704x480').ok && /already 704x480/.test(planRes(yard, '704x480').reason))
check('a size the camera does not offer is refused', !planRes(yard, '2560x1440').ok && /does not offer 2560x1440/.test(planRes(yard, '2560x1440').reason))
check('a recorder channel, an offline camera and one without a sub-stream are refused', !planRes({ ...yard, chlType: 'recorder' }, '1280x720').ok && !planRes({ ...yard, resolutions: [] }, '1280x720').ok && !planRes({ ...yard, sub: null }, '1280x720').ok)
check('the checks on what is sent still refuse an unoffered size or too high a rate', !passes(yard, { ...up.sub, res: '2560x1440' }) && !passes(yard, { ...top.sub, fps: '20' }))

// what the POST may ask for
const status = (fn) => {
  try {
    fn()
    return 200
  } catch (e) {
    return e.status
  }
}
const ask = (extra) => requestOf({ action: 'res', res: '1280x720', channels: [ID], ...extra })
check('POST: a size for one camera', JSON.stringify(ask()) === JSON.stringify({ action: 'res', ids: [ID], res: '1280x720' }))
check('POST: only one camera at a time for a size', status(() => ask({ channels: [ID, '{00000004-0000-0000-0000-000000000000}'] })) === 400 && status(() => ask({ channels: [] })) === 400)
check('POST: the size must be named, as WIDTHxHEIGHT', [undefined, '', 'big', '1280', 1280, '1280x720; x', '1280X720'].every((res) => status(() => ask({ res })) === 400))
check('POST: a channel id must be the NVR\'s own form', status(() => ask({ channels: ['3'] })) === 400)
check('POST: the codec switch and its Undo are as before (many cameras, no size)', JSON.stringify(requestOf({ action: 'h264', channels: [ID, ID, '{00000004-0000-0000-0000-000000000000}'] })) === JSON.stringify({ action: 'h264', ids: [ID, '{00000004-0000-0000-0000-000000000000}'], res: null }) && requestOf({ action: 'undo', channels: [ID], res: '1280x720' }).res === null)
check('POST: any other action is refused (the fleet frame-rate change is not on the route)', status(() => requestOf({ action: 'fps', channels: [ID] })) === 400 && status(() => requestOf({ channels: [ID] })) === 400)
check('POST: the size must be one this camera offers (its own list)', status(() => requireOffered(info.channels, ID, '1280x720')) === 200 && status(() => requireOffered(info.channels, ID, '2560x1440')) === 400 && status(() => requireOffered(info.channels, '{00000009-0000-0000-0000-000000000000}', '1280x720')) === 404 && status(() => requireOffered([{ ...yard, resolutions: [] }], ID, '1280x720')) === 400)

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
