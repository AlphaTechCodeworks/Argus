// Offline tests for the lens controls (no NVR, nothing sent anywhere). Uses the lens answers
// saved from the real cameras (test/fixtures/imaging/*/lens-*.xml) and a stub for the SDK call.
//   node cctv/test/lens.test.mjs [fixtures folder]
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-lens-test-'))
const { _test, handleLens } = await import('../lens.mjs')
const xmlMod = await import('../nvr-xml.mjs')
const { nvrs } = await import('../nvrs.mjs')
const { Lane } = await import('../lanes.mjs')

const { parseLens, buildSave, buildCall, saveImpacts, lightOk, TIMING } = _test
const dir = process.argv[2] ?? join(import.meta.dirname, 'fixtures', 'imaging')
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const read = (nvr, file) => readFileSync(join(dir, nvr, `${file}.xml`), 'utf8')
const HEAD = '<?xml version="1.0" encoding="utf-8" ?><request version="1.0" systemType="NVMS-9000" clientType="WEB">'
const JPB = '{00000018-0000-0000-0000-000000000000}'

const offline = parseLens(read('nvr1', 'lens-00000011')) // ONVIF camera: the NVR refuses
const empty = parseLens(read('nvr1', 'lens-00000002')) // "success" but no content: no motorised lens
const jpb = parseLens(read('nvr-2', 'lens-00000018'))
check('refused answer -> not supported, with the reason', offline.supported === false && /536870962/.test(offline.reason))
check('success without content -> not supported (the page\'s rule)', empty.supported === false && /no motorised lens/.test(empty.reason))
check('JPB DOOR: manual focus, refocus off, interval 60, choices', jpb.supported && jpb.focusType === 'manual' && jpb.focusTypes.join() === 'manual' && jpb.IrchangeFocus === false && jpb.timeInterval === 60 && jpb.intervals.join() === '60,300,600,1800,0')
check(
  'save: the page\'s document, interval always 0 in manual focus',
  buildSave(JPB, jpb, true) === `${HEAD}<content><chl id="${JPB}"><focusType type="focusType">manual</focusType><IrchangeFocus>true</IrchangeFocus><timeInterval>0</timeInterval></chl></content></request>`
)
const imp = saveImpacts(jpb)
check('save: acknowledgement for the interval Undo cannot restore', imp.length === 1 && imp[0].key === 'lens-interval' && /from 60 to 0/.test(imp[0].text) && /Undo cannot put 60 back/.test(imp[0].text))
check('save: no acknowledgement when the interval is already 0', saveImpacts({ ...jpb, timeInterval: 0 }).length === 0)
check('focus call document', buildCall(JPB, 'OneKeyFocus') === `${HEAD}<content><chlId>${JPB}</chlId><actionType>OneKeyFocus</actionType></content></request>`)
check('focus only in good light', lightOk({ period: 'day' }) && lightOk({ period: 'night', mono: false, mean: 95 }) && !lightOk({ period: 'night', mono: true, mean: 120 }) && !lightOk({ period: 'dusk', mono: false, mean: 60 }) && !lightOk(null))

// ---- with a stub for the SDK call ---------------------------------------------------------------
TIMING.verifyMs = 5
TIMING.stopAfterMs = 1
const calls = []
let lens = read('nvr-2', 'lens-00000018')
let failFocus = false
xmlMod._test.setCall(async (opts, userId, xml, url, out, outSize, len) => {
  calls.push({ url, xml, tag: opts.tag })
  let answer = '<?xml version="1.0" encoding="UTF-8"?><response><status>success</status></response>'
  if (url === 'queryCameraLensCtrlParam') answer = /00000018/.test(xml) ? lens : read('nvr1', 'lens-00000002')
  else if (url === 'editCameraLensCtrlParam') lens = lens.replace(/<IrchangeFocus>\w+<\/IrchangeFocus>/, `<IrchangeFocus>${/<IrchangeFocus>true/.test(xml)}</IrchangeFocus>`).replace(/<timeInterval>\d+<\/timeInterval>/, `<timeInterval>${/<timeInterval>(\d+)/.exec(xml)[1]}</timeInterval>`)
  else if (url === 'cameraLensCtrlCall' && failFocus && /OneKeyFocus/.test(xml)) throw new Error('the NVR did not answer')
  const b = Buffer.from(answer)
  b.copy(out)
  len.writeUInt32LE(b.length)
  return true
})
const nvr = {
  id: 'l1', name: 'NVR l1', site: 'Test', cfg: { host: '192.168.9.3', port: 6036 }, status: 'online',
  get online() {
    return this.status === 'online'
  },
  degraded: false, userId: 3, gen: 1, stopped: false, lane: new Lane('l1', 2),
  channels: [{ ch: 23, name: 'JPB DOOR', online: true }, { ch: 1, name: 'PW Exit', online: true }]
}
nvrs.set(nvr.id, nvr)
const DEV = '192.168.9.3:6036'
const post = (ch, body) => handleLens('POST', nvr.id, ch, async () => body, 'tester')
const sent = (url) => calls.filter((c) => c.url === url)

const [st, g] = await handleLens('GET', nvr.id, 23, async () => ({}), 'tester')
check('GET: supported, with the save\'s acknowledgement shown', st === 200 && g.lens.supported && g.lens.impacts[0]?.key === 'lens-interval' && g.lens.undo === null)
const [st1, b1] = await post(23, { device: DEV, action: 'save', IrchangeFocus: true, seen: { IrchangeFocus: false }, confirm: true })
check('save: 409 needsAck with a token, nothing sent', st1 === 409 && b1.needsAck[0].key === 'lens-interval' && typeof b1.ackToken === 'string' && sent('editCameraLensCtrlParam').length === 0)
const [st2] = await post(23, { device: DEV, action: 'save', IrchangeFocus: true, seen: { IrchangeFocus: true }, ack: ['lens-interval'], ackToken: b1.ackToken, confirm: true })
check('save: stale -> 409, nothing sent', st2 === 409 && sent('editCameraLensCtrlParam').length === 0)
const [st3, b3] = await post(23, { device: DEV, action: 'save', IrchangeFocus: true, seen: { IrchangeFocus: false }, ack: ['lens-interval'], ackToken: b1.ackToken, confirm: true })
check('save: sent with interval 0, read back', st3 === 200 && b3.result.status === 'done' && sent('editCameraLensCtrlParam').length === 1 && /<timeInterval>0<\/timeInterval>/.test(sent('editCameraLensCtrlParam')[0].xml) && b3.lens.IrchangeFocus === true && b3.lens.timeInterval === 0, JSON.stringify(b3))
check('save: Undo offered, putting back only the switch', b3.lens.undo?.seq === b3.result.seq)
const [st4, b4] = await post(23, { device: DEV, action: 'undo', seq: b3.result.seq, confirm: true })
check('undo: the switch back off, the interval stays 0', st4 === 200 && b4.result.status === 'done' && /<IrchangeFocus>false<\/IrchangeFocus><timeInterval>0/.test(sent('editCameraLensCtrlParam')[1].xml) && b4.lens.timeInterval === 0, JSON.stringify(b4.result))
const [st5] = await post(23, { device: DEV, action: 'undo', seq: b3.result.seq, confirm: true })
check('undo: only once', st5 === 409)
{
  // the interval is 60 again (set on the camera's own page); save (acknowledged), then someone
  // sets it back to 60 once more: the Undo would send 0 again, which can't be put back, so it
  // asks the same confirmation
  lens = lens.replace(/<timeInterval>\d+<\/timeInterval>/, '<timeInterval>60</timeInterval>')
  const [, a1] = await post(23, { device: DEV, action: 'save', IrchangeFocus: true, seen: { IrchangeFocus: false }, confirm: true })
  const [, a2] = await post(23, { device: DEV, action: 'save', IrchangeFocus: true, seen: { IrchangeFocus: false }, ack: ['lens-interval'], ackToken: a1.ackToken, confirm: true })
  lens = lens.replace(/<timeInterval>\d+<\/timeInterval>/, '<timeInterval>60</timeInterval>')
  const edits = sent('editCameraLensCtrlParam').length
  const [u1, ub1] = await post(23, { device: DEV, action: 'undo', seq: a2.result.seq, confirm: true })
  check('undo with the interval set again (60): 409 lens-interval, nothing sent', u1 === 409 && ub1.needsAck?.[0]?.key === 'lens-interval' && /it cannot be put back from here/.test(ub1.needsAck[0].text) && sent('editCameraLensCtrlParam').length === edits, JSON.stringify(ub1))
  const [u2] = await post(23, { device: DEV, action: 'undo', seq: a2.result.seq, ack: ['lens-interval'], ackToken: a1.ackToken, confirm: true })
  check('  the save\'s token does not cover the Undo', u2 === 409 && sent('editCameraLensCtrlParam').length === edits)
  const [u3, ub3] = await post(23, { device: DEV, action: 'undo', seq: a2.result.seq, ack: ['lens-interval'], ackToken: ub1.ackToken, confirm: true })
  check('  acknowledged: sent', u3 === 200 && ub3.result.status === 'done' && sent('editCameraLensCtrlParam').length === edits + 1, JSON.stringify(ub3.result))
}

const [st6, b6] = await post(23, { device: DEV, action: 'focus', confirm: true })
check('focus: refused without good light, nothing sent', st6 === 400 && /good light/.test(b6.error) && sent('cameraLensCtrlCall').length === 0)
const [st7, b7] = await post(23, { device: DEV, action: 'focus', light: { period: 'day', mono: false, mean: 120 }, confirm: true })
const lensCalls = sent('cameraLensCtrlCall')
check('focus: OneKeyFocus then Stop', st7 === 200 && b7.result.status === 'done' && lensCalls.length === 2 && /OneKeyFocus/.test(lensCalls[0].xml) && /<actionType>Stop</.test(lensCalls[1].xml))
failFocus = true
const [st8, b8] = await post(23, { device: DEV, action: 'focus', light: { period: 'day' }, confirm: true })
const after = sent('cameraLensCtrlCall')
check('focus: Stop is sent even when OneKeyFocus failed', st8 === 200 && b8.result.status === 'failed' && after.length === 4 && /<actionType>Stop</.test(after[3].xml), JSON.stringify(b8))
failFocus = false
const [st9, b9] = await post(1, { device: DEV, action: 'save', IrchangeFocus: true, seen: { IrchangeFocus: false }, confirm: true })
check('a camera without a lens: refused', st9 === 400 && /No lens control/.test(b9.error))
const [st10] = await handleLens('POST', nvr.id, 23, async () => null, 'tester')
check('a JSON null body is a 400', st10 === 400)
const [st11] = await handleLens('PUT', nvr.id, 23, async () => ({}), 'tester')
check('other methods: 405', st11 === 405)
check('no zoom, near or far ever sent', !calls.some((c) => /ZoomIn|ZoomOut|<actionType>(Near|Far)</.test(c.xml)))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
