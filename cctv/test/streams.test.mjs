// Offline tests for the main-stream box (no NVR, nothing sent anywhere). Uses queryNodeEncodeInfo
// answers saved from the real NVRs (test/fixtures/streams: a few channels each, their quality
// lists cut to the sizes each camera offers) and a stub for the SDK call.
//   node cctv/test/streams.test.mjs [fixtures folder]
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-streams-test-'))
const { _test, handleStreams } = await import('../streams.mjs')
const xmlMod = await import('../nvr-xml.mjs')
const { nvrs } = await import('../nvrs.mjs')
const { Lane } = await import('../lanes.mjs')

const { parseEncode, current, qoiList, digitalDefault, whyNot, planChange, buildEdit, buildRemain, parseRemain, worstCase, recommendedRange, optimisePlan, capPlan, downTarget, TIMING } = _test
const dir = process.argv[2] ?? join(import.meta.dirname, 'fixtures', 'streams')
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const refuses = (fn, pattern) => {
  try {
    fn()
    return false
  } catch (e) {
    return e.status === 400 && pattern.test(e.message)
  }
}
const HEAD = '<?xml version="1.0" encoding="utf-8" ?><request version="1.0" systemType="NVMS-9000" clientType="WEB">'
const nvr1 = parseEncode(readFileSync(join(dir, 'nvr1-queryNodeEncodeInfo.xml'), 'utf8'))
const nvr2 = parseEncode(readFileSync(join(dir, 'nvr-2-queryNodeEncodeInfo.xml'), 'utf8'))
const by = (info, hex) => info.items.find((i) => i.id.startsWith(`{${hex}`))
const pwExit = by(nvr1, '00000002')
const pwEntrance = by(nvr1, '00000004')
const gate = by(nvr1, '0000000E')
const cage = by(nvr1, '0000001F')
const southFence = by(nvr2, '00000005')
const bike = by(nvr2, '00000007')
const driveWay = by(nvr2, '0000000A')
const ferto = by(nvr2, '00000015')
const sys = { recMode: 'auto', loopRecSwitch: true, totalBandwidth: 256, usedTotalBandwidth: 120_000, mainStreamLimitFps: null, poeMode: '100' }

check('parses the saved answers', nvr1.status === 'success' && nvr1.items.length === 5 && nvr2.items.length === 5)
check('North Gate: 4K H.265 at 5120, VBR higher', JSON.stringify(current(gate)) === '{"enct":"h265","res":"3840x2160","fps":20,"QoI":5120,"level":"higher","bitType":"VBR"}')
check('the NVR\'s bitrate choices', qoiList(gate, sys, 'h265', '3840x2160').join() === '32,64,128,256,512,768,1024,1536,2048,3072,4096,5120,6144,8192,10240')
check('poeMode 10: at most 6144, as the page offers', qoiList(gate, { ...sys, poeMode: '10' }, 'h265', '3840x2160').at(-1) === 6144)
check('digitalDefault: South Fence H.264 3200x1800 = 6144; GG Ferto 2688x1520 = 5120; Bike Parking 2560x1440 = 5120', digitalDefault(southFence, 'h264', '3200x1800') === 6144 && digitalDefault(ferto, 'h264', '2688x1520') === 5120 && digitalDefault(bike, 'h264', '2560x1440') === 5120)
const range = recommendedRange({ res: '3200x1800', level: 'higher', fps: 20, enct: 'h265' }, 10240)
check('GetBitrateRange: 3200x1800@20 H.265 minimum 5282', range.min === 5282, JSON.stringify(range))

// who may be changed here
check('candidate: a TVT camera in automatic record mode', whyNot(gate, sys, true) === null)
check('not: no bitrate type (LCL Cage)', /no bitrate type/.test(whyNot(cage, sys, true)))
check('not: a camera that ignores its cap (measured 1.91 of it)', /does not keep to its bitrate cap/.test(whyNot(pwEntrance, sys, true, 1.91)) && whyNot(pwEntrance, sys, true, 0.96) === null)
check('not: manual record mode (its page was never seen)', /manual mode/.test(whyNot(gate, { ...sys, recMode: 'manually' }, true)))
check('not: normal and event streams differ', /differ/.test(whyNot({ ...gate, ae: { ...gate.ae, QoI: '4096' } }, sys, true)))
check('not: camera offline', /offline/.test(whyNot(gate, sys, false)))

// what may change
const { next } = planChange(gate, sys, { QoI: 6144 })
check('a raise to the next step is planned', next.QoI === 6144 && next.res === '3840x2160' && next.enct === 'h265')
check(
  'the exact edit shape (the page\'s getSaveData), everything else echoed',
  buildEdit(gate, next) ===
    `${HEAD}<content type="list" total="1"><item id="{0000000E-0000-0000-0000-000000000000}"><an res="3840x2160" fps="20" QoI="6144" audio="ON" type="main" bitType="VBR" level="higher"></an><ae res="3840x2160" fps="20" QoI="6144" audio="ON" type="main" bitType="VBR" level="higher"></ae><main enct="h265" aGOP="40" ></main></item></content></request>`
)
check('refused: lowering the cap', refuses(() => planChange(gate, sys, { QoI: 4096 }), /never lowers the bitrate cap/))
check('refused: lowering the frame rate or quality level', refuses(() => planChange(gate, sys, { fps: 15 }), /frame rate/) && refuses(() => planChange(gate, sys, { level: 'medium' }), /quality level/))
check('refused: a value not in the NVR\'s list', refuses(() => planChange(gate, sys, { QoI: 7000 }), /not one of the NVR's choices/))
check('refused: over 6144 on poeMode 10', refuses(() => planChange(gate, { ...sys, poeMode: '10' }, { QoI: 8192 }), /6144/))
check('refused: attributes outside the allow-list', refuses(() => planChange(gate, sys, { audio: 'OFF' }), /cannot be changed here/) && refuses(() => planChange(gate, sys, { recMode: 'manual' }), /cannot be changed here/))
// Bitrate type became changeable on 2026-09-25: cameras pinned to a fixed rate cost the same
// bandwidth and disk whether anything is happening or not, which is what filled nvr-2's budget.
check('bitrate type can be changed to one the camera offers', planChange(gate, sys, { bitType: 'CBR' }).next.bitType === 'CBR')
check('... and back again', planChange(gate, sys, { bitType: 'VBR' }).next.bitType === 'VBR')
check('refused: a bitrate type that is not one of the two', refuses(() => planChange(gate, sys, { bitType: 'ABR' }), /bitrate type ABR/))
// The camera's own list decides, never a guess: a model that offers only one must not be asked
// for the other.
check('refused: a bitrate type this camera does not offer',
  refuses(() => planChange({ ...gate, bitTypes: ['VBR'] }, sys, { bitType: 'CBR' }), /not offered by this camera/))
check('a camera whose list the NVR withheld keeps what it has', planChange({ ...gate, bitTypes: [] }, sys, { bitType: 'VBR' }).next.bitType === 'VBR')
check('refused: a codec or size the camera does not offer', refuses(() => planChange(gate, sys, { enct: 'mjpeg' }), /codec/) && refuses(() => planChange(gate, sys, { res: '4000x3000' }), /resolution/))
check('S5: a bigger picture alone is refused', refuses(() => planChange(driveWay, sys, { res: '3840x2160' }), /bitrate raised with it/))
check('S5: ... and with too small a raise', refuses(() => planChange(driveWay, sys, { res: '3840x2160', QoI: 8192 }), /at least 10240/))
check('S5: with the cap raised in proportion (2.03x -> 10240, the top step)', planChange(driveWay, sys, { res: '3840x2160', QoI: 10240 }).next.res === '3840x2160')
check('S4: H.265+ to H.265 at the same cap', planChange(pwExit, sys, { enct: 'h265' }).next.enct === 'h265')
check('S6: H.264 to H.265 at the same cap', planChange(bike, sys, { enct: 'h265' }).next.enct === 'h265')
check('"never lowers anything": H.265 -> H.264 refused', refuses(() => planChange(pwEntrance, sys, { enct: 'h264' }), /codec only from H\.265\+ to H\.265 or from H\.264 to H\.265/))
check('  H.265 -> H.265+ (a smart codec) refused', refuses(() => planChange(gate, sys, { enct: 'h265p' }), /not h265 to h265p/))
check('  a higher frame rate at the same cap (fewer bits per frame) refused', refuses(() => planChange(bike, sys, { fps: 30 }), /more frames per second needs the bitrate raised with it \(4096 × 1\.50 → at least 6144 kbps\)/))
check('  ... allowed with the cap raised in proportion', planChange(bike, sys, { fps: 30, QoI: 6144 }).next.fps === 30)
{
  const text = (item, change) => {
    const { cur, next } = planChange(item, sys, change)
    return _test.impactsOf(cur, next)[0].text
  }
  check('storage text: a cap raise', /^Recording uses up to 6144 instead of 5120 kbit\/s for this camera: the NVR keeps fewer days/.test(text(gate, { QoI: 6144 })))
  check('  same cap, higher level: sends closer to the cap', /^The cap stays at 5120 kbit\/s, but with quality level higher → highest the camera sends closer to it/.test(text(gate, { level: 'highest' })), text(gate, { level: 'highest' }))
  check('  H.264 -> H.265 at the same cap: not "fewer days"', /H\.265 gives a better picture/.test(text(bike, { enct: 'h265' })) && !/fewer days/.test(text(bike, { enct: 'h265' })))
}
// mainStreamLimitFps is the NVR's MINIMUM main-stream frame rate (1 on these NVRs), not a maximum
check('mainStreamLimitFps 1 (a minimum): 30 fps allowed', planChange(bike, { ...sys, mainStreamLimitFps: 1 }, { fps: 30, QoI: 6144 }).next.fps === 30)
check('mainStreamLimitFps 25: 30 fps is above the minimum, allowed', planChange(bike, { ...sys, mainStreamLimitFps: 25 }, { fps: 30, QoI: 6144 }).next.fps === 30)
check('mainStreamLimitFps 25: Undo to 20 fps is below the minimum, refused', refuses(() => planChange(bike, { ...sys, mainStreamLimitFps: 25 }, null, { undoTo: { fps: 20 } }), /frame rate 20/))
check('Undo may lower the cap, but only to the logged values', planChange({ ...gate, an: { ...gate.an, QoI: '6144' }, ae: { ...gate.ae, QoI: '6144' } }, sys, null, { undoTo: { enct: 'h265', res: '3840x2160', fps: 20, QoI: 5120, level: 'higher' } }).next.QoI === 5120)

// the NVR's storage estimate, with every channel
const remain = buildRemain(nvr1.items, { [gate.id]: 6144 })
const rows = [...remain.matchAll(/<item id="(\{[^}]+\})"><QoI>(\d+)<\/QoI><\/item>/g)].map((m) => [m[1].slice(1, 9), m[2]])
check('queryRemainRecTime: every enabled channel, the changed one replaced', remain.startsWith(`${HEAD}<content><recMode type="recModeType">auto</recMode><streamType type="streamType">Main</streamType><chls type="list">`) && rows.length === 5 && rows.find((r) => r[0] === '0000000E')[1] === '6144' && rows.find((r) => r[0] === '00000002')[1] === '4096', JSON.stringify(rows))
check('queryRemainRecTime answer', JSON.stringify(parseRemain('<response><status>success</status><content><item><remainRecTime>31</remainRecTime><diskGroupIndex>1</diskGroupIndex></item></content></response>').groups) === '[{"days":31,"group":"1"}]')
const wc = worstCase({ QoI: 5120 }, { QoI: 6144 }, 4900)
check('worst case: measured rate against the new cap', wc.extraKbps === 1244 && wc.gbPerDay === 13.4 && /now sends 4900 of 5120 kbit\/s\. After the change it may send up to 6144: \+1244 kbit\/s = \+13\.4 GB\/day/.test(wc.text), wc.text)
const wc2 = worstCase({ QoI: 4096 }, { QoI: 4096 }, 1200)
check('worst case: same cap (level/codec/size) -> up to the cap', wc2.extraKbps === 2896 && /does not change; real use may rise by up to 2896 kbit\/s/.test(wc2.text), wc2.text)

// ---- with a stub for the SDK call ---------------------------------------------------------------
TIMING.verifyMs = 5
const escA = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const raw = readFileSync(join(dir, 'nvr1-queryNodeEncodeInfo.xml'), 'utf8')
const doc = xmlMod.kid(xmlMod.parseXml(raw), 'response')
const ser = (n) => `<${n.name}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escA(v)}"`).join('')}>${n.children.length ? n.children.map(ser).join('') : escA(n.text.trim())}</${n.name}>`
const items = () => xmlMod.kids(xmlMod.kid(doc, 'content'), 'item')
const calls = []
let perChannel = true
let editAnswer = '<response><status>success</status></response>'
let days = [41, 37] // the NVR's estimate: now, and with North Gate at 6144
let remainFails = false
xmlMod._test.setCall(async (opts, userId, xml, url, out, outSize, len) => {
  calls.push({ url, xml })
  let answer = '<response><status>success</status><content></content></response>'
  if (url === 'queryNodeEncodeInfo') {
    const id = /<chlId>(\{[^}]+\})<\/chlId>/.exec(xml)?.[1]
    if (id && !perChannel) answer = '<response><status>fail</status><errorCode>536870943</errorCode></response>'
    else answer = `<response><status>success</status><content type="list">${items().filter((i) => !id || i.attrs.id === id).map(ser).join('')}</content></response>`
  } else if (url === 'queryRecordDistributeInfo') answer = '<response><status>success</status><content><recMode><mode>auto</mode></recMode><loopRecSwitch>true</loopRecSwitch><doubleStreamRecSwitch>false</doubleStreamRecSwitch></content></response>'
  else if (url === 'querySystemCaps') answer = '<response><status>success</status><content><totalBandwidth>256</totalBandwidth><usedTotalBandwidth>120000</usedTotalBandwidth></content></response>'
  else if (url === 'queryNetCfgV2') answer = '<response><status>success</status><content><poeMode>100</poeMode></content></response>'
  else if (url === 'queryRemainRecTime') answer = remainFails ? '<response><status>fail</status><errorCode>536870913</errorCode></response>' : `<response><status>success</status><content><item><remainRecTime>${/<QoI>6144</.test(xml) ? days[1] : days[0]}</remainRecTime><diskGroupIndex>1</diskGroupIndex></item></content></response>`
  else if (url === 'editNodeEncodeInfo') {
    answer = editAnswer
    if (/success/.test(editAnswer)) {
      const sent = xmlMod.kid(xmlMod.kid(xmlMod.kid(xmlMod.parseXml(xml), 'request'), 'content'), 'item')
      const item = items().find((i) => i.attrs.id === sent.attrs.id)
      for (const k of ['an', 'ae', 'main']) Object.assign(xmlMod.kid(item, k).attrs, xmlMod.kid(sent, k).attrs)
    }
  }
  const b = Buffer.from(answer)
  b.copy(out)
  len.writeUInt32LE(b.length)
  return true
})
const nvr = {
  id: 's1', name: 'NVR s1', site: 'Test', cfg: { host: '192.168.9.4', port: 6036 }, status: 'online',
  get online() {
    return this.status === 'online'
  },
  degraded: false, userId: 4, gen: 1, stopped: false, lane: new Lane('s1', 2),
  channels: [[1, 'PW Exit'], [3, 'PW Entrance'], [13, 'North Gate'], [26, 'truckview'], [30, 'LCL Cage']].map(([ch, name]) => ({ ch, name, online: true }))
}
nvrs.set(nvr.id, nvr)
const DEV = '192.168.9.4:6036'
const q = (s = '') => new URLSearchParams(s)
const edits = () => calls.filter((c) => c.url === 'editNodeEncodeInfo')

const [st, g] = await handleStreams('stream', 'GET', nvr.id, 13, q('usage=0.96'), async () => ({}), 'tester')
check('GET: stream, choices, default, candidate', st === 200 && g.stream.current.QoI === 5120 && g.stream.candidate === true && g.stream.digitalDefault === 5120 && g.stream.qoiList.at(-1) === 10240 && g.stream.recMode === 'auto' && g.stream.pair === 'an/ae', JSON.stringify(g).slice(0, 300))
check('GET: read only', edits().length === 0)
perChannel = false
const [stF, gF] = await handleStreams('stream', 'GET', nvr.id, 30, q(), async () => ({}), 'tester')
check('GET: falls back to the all-channel read when the NVR refuses the per-channel one', stF === 200 && gF.stream.current.QoI === 3072 && gF.stream.candidate === false && /no bitrate type/.test(gF.stream.why))
perChannel = true
const [stG] = await handleStreams('estimate', 'GET', nvr.id, 13, q(), async () => ({}), 'tester')
check('estimate: GET is 405 (it takes a body)', stG === 405)
const before = calls.length
const [stE, e] = await handleStreams('estimate', 'POST', nvr.id, 13, q(), async () => ({ change: { QoI: 6144 }, measuredKbps: 4900 }), 'tester')
const remainCalls = calls.slice(before).filter((c) => c.url === 'queryRemainRecTime')
check('estimate: the NVR asked twice, with all channels each time', stE === 200 && remainCalls.length === 2 && remainCalls.every((c) => (c.xml.match(/<item id=/g) ?? []).length === 5) && /<QoI>6144</.test(remainCalls[1].xml) && !/<QoI>6144</.test(remainCalls[0].xml))
check('estimate: days before and after, bandwidth, worst case, impacts; nothing written', e.estimate.remain.before[0].days === 41 && e.estimate.remain.after[0].days === 37 && e.estimate.retention.minDays === 30 && e.estimate.retention.refused === null && e.estimate.bandwidth.freeBeforeMbps === 138.8 && e.estimate.worstCase.extraKbps === 1244 && e.estimate.impacts[0].key === 'storage' && edits().length === 0, JSON.stringify(e.estimate))

// bitType joined the stream's settings on 2026-09-25, so the page now shows it and must say it saw it.
const seen = { enct: 'h265', res: '3840x2160', fps: 20, QoI: 5120, level: 'higher', bitType: 'VBR' }
const post = (ch, body) => handleStreams('stream', 'POST', nvr.id, ch, q(), async () => body, 'tester')

// the site's minimum of 30 days of recordings (site facts): refused, never offered
const estimateGate = async () => (await handleStreams('estimate', 'POST', nvr.id, 13, q(), async () => ({ change: { QoI: 6144 } }), 'tester'))[1].estimate
days = [31, 27]
const eR = await estimateGate()
check('retention: an estimate under 30 days is refused, and says why', /^Refused: the NVR estimates 27 days of recordings after it, under the site's minimum of 30\.$/.test(eR.retention.refused), eR.retention.refused)
const [sR, bR] = await post(13, { device: DEV, change: { QoI: 6144 }, seen, confirm: true })
check('retention: apply refused before any confirmation; nothing sent', sR === 400 && /^Refused: the NVR estimates 27 days.*Nothing was sent\.$/.test(bR.error) && edits().length === 0, bR.error)
days = [0, 0]
const eC = await estimateGate()
check('retention: cycle recording (0 days) -> refused, the minimum can\'t be confirmed', /not available \(cycle recording\)/.test(eC.retention.refused ?? '') && eC.remain.cycle === true, eC.retention.refused)
days = [41, 37]
remainFails = true
const eF = await estimateGate()
const [sF, bF] = await post(13, { device: DEV, change: { QoI: 6144 }, seen, confirm: true })
check('retention: no estimate from the NVR -> refused (estimate and apply)', /not available, so the site's minimum/.test(eF.retention.refused ?? '') && sF === 400 && edits().length === 0, bF.error)
remainFails = false
const rr = _test.retentionRefusal
const grp = (...d) => ({ ok: true, groups: d.map((x, i) => ({ days: x, group: String(i + 1) })) })
check('retention: a lower cap (Undo) or the same cap is never refused', rr({ QoI: 6144 }, { QoI: 5120 }, grp(20), grp(22), false) === null && rr({ QoI: 4096, enct: 'h265p' }, { QoI: 4096, enct: 'h265' }, { ok: false }, { ok: false }, true) === null)
check('retention: 30 days exactly is allowed', rr({ QoI: 5120 }, { QoI: 6144 }, grp(33), grp(30), false) === null)
check('retention: only the disk group that drops counts; named when there are several', /29 days \(disk group 2\)/.test(rr({ QoI: 5120 }, { QoI: 6144 }, grp(12, 31), grp(12, 29), false) ?? '') && rr({ QoI: 5120 }, { QoI: 6144 }, grp(12, 45), grp(12, 40), false) === null)
const [s1, b1] = await post(13, { device: DEV, change: { QoI: 6144 }, seen, confirm: true })
check('apply: storage acknowledgement with a token first', s1 === 409 && b1.needsAck.map((x) => x.key).join() === 'storage' && edits().length === 0)
const [s2] = await post(13, { device: DEV, change: { QoI: 6144 }, seen: { ...seen, QoI: 4096 }, ack: ['storage'], ackToken: b1.ackToken, confirm: true })
check('apply: stale -> 409', s2 === 409 && edits().length === 0)
const [s3, b3] = await post(13, { device: DEV, change: { QoI: 6144 }, seen, ack: ['storage'], ackToken: b1.ackToken, confirm: true })
check('apply: sent in the page\'s shape, read back', s3 === 200 && b3.result.status === 'done' && edits().length === 1 && edits()[0].xml.includes('<an res="3840x2160" fps="20" QoI="6144" audio="ON" type="main" bitType="VBR" level="higher"></an>') && b3.stream.current.QoI === 6144, JSON.stringify(b3.result))
check('apply: undo offered', b3.stream.undo?.seq === b3.result.seq)
const [s4, b4] = await post(13, { device: DEV, change: { QoI: 5120 }, seen: { ...seen, QoI: 6144 }, ack: ['storage'], ackToken: 'x', confirm: true })
check('apply: lowering refused outright', s4 === 400 && /never lowers/.test(b4.error))
const [s5, b5] = await post(13, { device: DEV, undo: true, seq: b3.result.seq, confirm: true })
const [s6, b6] = await post(13, { device: DEV, undo: true, seq: b3.result.seq, ack: ['storage'], ackToken: b5.ackToken, confirm: true })
check('undo: back to exactly the logged cap, with its acknowledgement', s5 === 409 && s6 === 200 && b6.result.status === 'done' && /QoI="5120"/.test(edits().at(-1).xml) && b6.stream.current.QoI === 5120, JSON.stringify(b6.result))
const [s7] = await post(13, { device: DEV, undo: true, seq: b3.result.seq, confirm: true })
check('undo: only once', s7 === 409)
const [s8, b8] = await post(1, { device: DEV, change: { enct: 'h265' }, seen: { enct: 'h265p', res: '3200x1800', fps: 20, QoI: 4096, level: 'higher', bitType: 'VBR' }, confirm: true })
check('codec change: storage and encoder-restart acknowledgements', s8 === 409 && b8.needsAck.map((x) => x.key).join() === 'storage,encoder-restart')
editAnswer = '<response><status>fail</status><errorCode>536871004</errorCode></response>'
const [s9, b9] = await post(1, { device: DEV, change: { enct: 'h265' }, seen: { enct: 'h265p', res: '3200x1800', fps: 20, QoI: 4096, level: 'higher', bitType: 'VBR' }, ack: ['storage', 'encoder-restart'], ackToken: b8.ackToken, confirm: true })
check('536871004 -> "over the NVR\'s bandwidth limit"', s9 === 200 && b9.result.status === 'failed' && /bandwidth limit/.test(b9.result.message), JSON.stringify(b9.result))
editAnswer = '<response><status>success</status></response>'
const [s10] = await post(30, { device: DEV, change: { QoI: 4096 }, seen: { enct: 'h264', res: '1280x960', fps: 30, QoI: 3072, level: 'higher' }, confirm: true })
check('not a candidate (LCL Cage) -> refused', s10 === 400)
const [s11] = await handleStreams('stream', 'POST', nvr.id, 13, q(), async () => null, 'tester')
check('a JSON null body is a 400', s11 === 400)
check('never written: record mode, dual-stream switch', !calls.some((c) => /editRecordDistributeInfo/.test(c.url)))

// ---- bulk optimiser: the H.265 + VBR plan (optimisePlan), against the real captures ----
{
  const sys = { recMode: 'auto', loopRecSwitch: false, totalBandwidth: null, usedTotalBandwidth: null, mainStreamLimitFps: null, poeMode: null }
  const plansFor = (file) => parseEncode(readFileSync(join(dir, file), 'utf8')).items.map((i) => ({ name: i.name, ...optimisePlan(i, sys, true) }))
  const n1 = plansFor('nvr1-queryNodeEncodeInfo.xml')
  const n2 = plansFor('nvr-2-queryNodeEncodeInfo.xml')
  const changed = (ps) => ps.filter((p) => p.change)
  const toH265 = (ps) => ps.filter((p) => p.moves?.some((m) => m.startsWith('enct h264→h265')))
  check('optimise: nvr1 proposes nothing (already H.265/H.265+, or its H.264 camera only offers H.264)', changed(n1).length === 0, changed(n1).map((p) => p.moves).join(';'))
  check('optimise: nvr-2 moves its 4 H.264 cameras to H.265', toH265(n2).length === 4, `h264→h265 ${toH265(n2).length}`)
  check('optimise: never moves off a smart codec (H.265+ left alone)', [...n1, ...n2].every((p) => !p.moves?.some((m) => /h26\dp→|h26\ds→/.test(m))))
  check('optimise: only ever H.264→H.265 and/or CBR→VBR', changed([...n1, ...n2]).every((p) => p.moves.every((m) => m.startsWith('enct h264→h265') || m.startsWith('bitType CBR→VBR'))))
  check('optimise: never lowers cap, fps, resolution or quality level', changed([...n1, ...n2]).every((p) => p.to.QoI === p.from.QoI && p.to.fps === p.from.fps && p.to.res === p.from.res && p.to.level === p.from.level))
}

// ---- resolution cap (downTarget + capPlan): the ONE place a resolution drop is allowed ----
{
  const item = { resolutions: [{ res: '3840x2160' }, { res: '2560x1440' }, { res: '1920x1080' }] }
  check('downTarget: 8MP capped at 4MP -> 2560x1440', downTarget(item, '3840x2160', 4e6) === '2560x1440')
  check('downTarget: picks the largest under the cap', downTarget(item, '3840x2160', 2.5e6) === '1920x1080')
  check('downTarget: nothing below the cap -> null', downTarget({ resolutions: [{ res: '1920x1080' }] }, '1920x1080', 4e6) === null)

  const sys = { recMode: 'auto', loopRecSwitch: false, totalBandwidth: null, usedTotalBandwidth: null, mainStreamLimitFps: null, poeMode: null }
  const items = parseEncode(readFileSync(join(dir, 'nvr1-queryNodeEncodeInfo.xml'), 'utf8')).items.filter((i) => i.an && i.resolutions.length)
  // cap at 2 MP so every captured camera (>= ~2.6 MP here) is over the cap and gets a lower resolution
  const capped = items.map((i) => ({ cur: current(i).res, ...capPlan(i, sys, true, 2e6) }))
  const changed = capped.filter((p) => p.change)
  check('cap: proposes a lower resolution for over-cap cameras (allowLowerRes lets planChange through)', changed.length > 0, `${changed.length} of ${capped.length}`)
  const px = (r) => r.split('x').map(Number).reduce((a, b) => a * b, 1)
  check('cap: every proposed target is below current and <= the 2 MP cap', changed.every((p) => px(p.to.res) < px(p.cur) && px(p.to.res) <= 2e6))
  check('cap: only the resolution changes (QoI, fps, codec, level kept)', changed.every((p) => p.to.QoI === p.from.QoI && p.to.fps === p.from.fps && p.to.enct === p.from.enct && p.to.level === p.from.level))
  check('cap: a camera already under the cap is skipped, not changed', capPlan(items[0], sys, true, 999e6).change === undefined)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
