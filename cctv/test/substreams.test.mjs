// Offline tests for the sub-stream switch (no NVR, nothing sent). Uses answers saved from
// the real NVRs and the web client's own request format.
//   node cctv/test/substreams.test.mjs <folder with live-nvr1-queryNetworkNodeEncodeInfo.xml>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _test } from '../substreams.mjs'

const { parseEncodeInfo, planH264, buildEdit, undoable, chNumber, validate } = _test
const dir = process.argv[2] ?? '/work'
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const nvr1 = parseEncodeInfo(readFileSync(join(dir, 'live-nvr1-queryNetworkNodeEncodeInfo.xml'), 'utf8'))
const nvr2 = parseEncodeInfo(readFileSync(join(dir, 'live-nvr-2-queryNetworkNodeEncodeInfo.xml'), 'utf8'))
check('parses the real answers', nvr1.status === 'success' && nvr1.channels.length === 23 && nvr2.channels.length === 25, `${nvr1.channels.length} + ${nvr2.channels.length}`)
check('channel numbers from item ids', chNumber('{00000011-0000-0000-0000-000000000000}') === 17 && chNumber('{bad}') === null)

const cranes = nvr1.channels.find((c) => chNumber(c.id) === 17)
const truck = nvr1.channels.find((c) => chNumber(c.id) === 27)
const h264 = nvr1.channels.find((c) => chNumber(c.id) === 2)
check('ch17 and ch27 are H.265, ch2 H.264', cranes.sub.enct === 'h265' && truck.sub.enct === 'h265' && h264.sub.enct === 'h264')

// the web client's own request for ch17 (research: subStream.js I(), values echoed, only enct changed)
const expected17 =
  '<?xml version="1.0" encoding="utf-8" ?><request version="1.0" systemType="NVMS-9000" clientType="WEB"><content type="list" total="1"><item id="{00000011-0000-0000-0000-000000000000}"><sub  res="704x576" fps="25" QoI="512"  bitType="VBR" level="higher" enct="h264"  GOP="50"></sub></item></content></request>'
const keep17 = planH264(cranes, 'keep')
check('ch17 "keep": same document as the NVR web page sends', keep17.ok && buildEdit(cranes.id, keep17.sub) === expected17)
const match17 = planH264(cranes, 'match')
check('ch17 "match": only enct and QoI differ (VBR: raised to the H.264 recommendation)', match17.ok && match17.sub.QoI === '1024' && ['res', 'fps', 'bitType', 'level', 'GOP'].every((k) => match17.sub[k] === cranes.sub[k]), JSON.stringify(match17.sub))
const match27 = planH264(truck, 'match')
check('ch27 "match": CBR takes the NVR H.264 default (1024, unchanged)', match27.ok && match27.sub.QoI === '1024' && match27.sub.bitType === 'CBR' && match27.sub.GOP === truck.sub.GOP)
check('H.264 channels are never planned', !planH264(h264).ok && /already/.test(planH264(h264).reason))
check('no NVR-2 channel is planned (all H.264)', nvr2.channels.every((c) => !planH264(c).ok))
check('a camera without H.264 is refused', !planH264({ ...cranes, supEnct: ['h265'] }).ok)
check('a recorder channel is refused', !planH264({ ...cranes, chlType: 'recorder' }).ok)
check('an offline camera (no resolutions) is refused', !planH264({ ...cranes, resolutions: [] }).ok)

// values are escaped in the document
const odd = buildEdit('{00000011-0000-0000-0000-000000000000}', { ...keep17.sub, level: 'a"b<c' })
check('attribute values are escaped', odd.includes('level="a&quot;b&lt;c"') && !odd.includes('a"b<c'))

// undo only when the channel still has the settings the NVR reported after this app's change
const dev = '192.168.0.228:6036'
const change = { kind: 'change', seq: 'a1', device: dev, id: cranes.id, action: 'h264', from: cranes.sub, to: match17.sub }
const result = { kind: 'result', seq: 'a1', result: 'done', after: match17.sub }
check('undo offered when unchanged since', Boolean(undoable([change, result], dev, { ...cranes, sub: match17.sub })))
check('no undo when changed since', !undoable([change, result], dev, { ...cranes, sub: { ...match17.sub, QoI: '768' } }))
check('no undo when only the quality level changed since', !undoable([change, result], dev, { ...cranes, sub: { ...match17.sub, level: 'lowest' } }))
check('no undo after an undo', !undoable([change, result, { ...change, seq: 'a2', action: 'undo' }], dev, { ...cranes, sub: match17.sub }))
check('no undo on another device with the same channel ids', !undoable([change, result], '192.168.0.226:6036', { ...cranes, sub: match17.sub }))
const storedDifferently = { ...match17.sub, GOP: '48' }
check('undo compares with what the NVR reported, not what was sent', Boolean(undoable([change, { ...result, after: storedDifferently }], dev, { ...cranes, sub: storedDifferently })))
check('undo offered even if the read-back failed (logged before sending)', Boolean(undoable([change], dev, { ...cranes, sub: match17.sub })))

// nothing odd ever goes out
const ok = (sub) => {
  try {
    validate(cranes, sub)
    return true
  } catch {
    return false
  }
}
check('valid switch passes the checks', ok(match17.sub))
check('empty bitType is refused', !ok({ ...match17.sub, bitType: '' }))
check('GOP "undefined" is refused', !ok({ ...match17.sub, GOP: 'undefined' }))
check('an unoffered resolution is refused', !ok({ ...match17.sub, res: '3840x2160' }))
check('too high a frame rate is refused', !ok({ ...match17.sub, fps: '60' }))
check('an unoffered codec is refused', !ok({ ...match17.sub, enct: 'h264s' }))

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
