// The line-crossing route (tripwire.mjs): the whole safe-change flow -- support, read, stale check,
// refusals, acknowledgements, write-ahead log, send, read-back, side effects, Undo, the NVR lock --
// against a fake NVR that answers from the answers captured from nvr-2 (test/fixtures/lines) and
// records every body sent. Nothing reaches a real NVR: handleLines gets its NVR list, its XML call
// and its settings through `deps`. tripwire.mjs imports nvr-xml.mjs and so loads the native SDK:
// this runs on the server copy, not on the Windows PC.
//   node cctv/test/tripwire-route.test.mjs [fixtures folder]
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-tripwire-test-'))
// a lines-on file left by an earlier run, with one entry that is not `true`: only the good one counts
writeFileSync(join(process.env.DATA_DIR, 'lines-on.json'), JSON.stringify({ 'old/4': true, 'old/5': 'yes' }))
const { LINES_LOG, LINES_ON_FILE, TIMING, handleLines, linesOn, noteLinesOn } = await import('../tripwire.mjs')
const { XML_HEADER, kid, parseXml } = await import('../xml.mjs')

const dir = process.argv[2] ?? join(import.meta.dirname, 'fixtures', 'lines')
let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const fixture = (f) => readFileSync(join(dir, f), 'utf8')
const logLines = () => (existsSync(LINES_LOG) ? readFileSync(LINES_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const savedOn = () => JSON.parse(readFileSync(LINES_ON_FILE, 'utf8'))

// ---- which cameras have line crossing on -------------------------------------------------------
check('linesOn: read once from the file, only entries that are true', [...linesOn()].join() === 'old/4', [...linesOn()].join())
noteLinesOn('old', 4, false)
check('noteLinesOn off: gone from memory and from the file', !linesOn().has('old/4') && JSON.stringify(savedOn()) === '{}')
noteLinesOn('x', 1, true)
check('noteLinesOn on: in memory and saved as { "<nvr>/<ch>": true }', linesOn().has('x/1') && JSON.stringify(savedOn()) === '{"x/1":true}')
const copy = linesOn()
copy.add('y/2')
check('linesOn hands out a copy', !linesOn().has('y/2'))
noteLinesOn('x', 1, false)

// ---- a fake NVR ----------------------------------------------------------------------------------
TIMING.verifyMs = [5, 10, 20]

const escT = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const escA = (v) => escT(v).replace(/"/g, '&quot;')
const ser = (n) => {
  const a = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escA(v)}"`).join('')
  return n.children.length ? `<${n.name}${a}>${n.children.map(ser).join('')}</${n.name}>` : `<${n.name}${a}>${escT(n.text.trim())}</${n.name}>`
}
const OK = '<?xml version="1.0" encoding="UTF-8"?><response><status>success</status></response>'
const REFUSE = (code) => `<?xml version="1.0" encoding="UTF-8"?><response><status>fail</status><errorCode>${code}</errorCode></response>`
const TIMEOUT = Symbol('timeout')

/** Copies every leaf of `src` onto the element of the same name and place in `dst` (a camera ignores what it lacks). */
function copyLeaves(dst, src) {
  const seen = new Map()
  for (const c of src.children) {
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    const d = dst.children.filter((x) => x.name === c.name)[n - 1]
    if (!d) continue
    if (c.children.length) copyLeaves(d, c)
    else if (!d.children.length) d.text = c.text
  }
}

/** Plays one camera: answers queryTripwire from its saved answer and applies editTripwire to it. */
class Camera {
  constructor(xml) {
    this.doc = kid(parseXml(xml), 'response')
    this.edits = [] // { xml, sent } in order
    this.onEdit = null // (edit, cam) => an answer string | { ignore } | { delay: reads } | { timeout } | { then(cam) } | undefined
    this.pending = [] // edits applied only after some more reads
    this.reads = 0
    this.readsAtEdit = 0
    this.offline = false
    this.logAtEdit = null // the last log line when the edit arrived (write-ahead check)
  }
  get chl() {
    return kid(kid(this.doc, 'content'), 'chl')
  }
  node(path) {
    let n = this.chl
    for (const k of path.split('.')) n = kid(n, k)
    return n
  }
  get(path) {
    return this.node(path)?.text.trim()
  }
  set(path, v) {
    this.node(path).text = String(v)
  }
  read() {
    this.reads++
    for (const p of this.pending) if (--p.left === 0) this.apply(p.sent)
    this.pending = this.pending.filter((p) => p.left > 0)
    if (this.offline) return REFUSE('536870962')
    return `<?xml version="1.0" encoding="UTF-8"?>${ser(this.doc)}`
  }
  apply(sent) {
    if (sent.attrs.scheduleGuid) this.chl.attrs.scheduleGuid = sent.attrs.scheduleGuid
    copyLeaves(this.chl, sent)
  }
  edit(xml) {
    const sent = kid(kid(kid(parseXml(xml), 'request'), 'content'), 'chl')
    this.edits.push({ xml, sent })
    this.readsAtEdit = this.reads
    const r = this.onEdit?.({ xml, sent }, this)
    if (typeof r === 'string') return r
    if (r?.delay) this.pending.push({ sent, left: r.delay })
    else if (!r?.ignore) this.apply(sent)
    r?.then?.(this)
    return r?.timeout ? TIMEOUT : OK
  }
}

const sent = [] // every call: { nvr, url, xml, tag, gen }
const urls = new Set()
const cams = new Map() // "nvrId|chlId" -> Camera
const nodeLists = new Map() // nvr id -> its queryNodeList answer
let hold = null // while set, an edit waits here "inside the NVR" (the lock test)
let arrived = () => {}
let degradeOnRead = null // this NVR goes into recovery right after its next line-crossing read
const fakeTransparent = async (nvr, url, xml, tag, opts = {}) => {
  sent.push({ nvr: nvr.id, url, xml, tag, gen: opts.gen })
  urls.add(url)
  if (url === 'queryNodeList') return nodeLists.get(nvr.id)
  if (url === 'queryScheduleList') return fixture('schedulelist.xml')
  const chlId = /\{[0-9A-F]{8}-0000-0000-0000-000000000000\}/i.exec(xml)?.[0]?.toUpperCase()
  const cam = cams.get(`${nvr.id}|${chlId}`)
  if (!cam) return REFUSE('536870943')
  if (url === 'queryTripwire') {
    const answer = cam.read()
    if (degradeOnRead === nvr) nvr.degraded = true
    return answer
  }
  if (url === 'editTripwire') {
    cam.logAtEdit = logLines().at(-1) ?? null
    arrived()
    if (hold) await hold
    const r = cam.edit(xml)
    if (r === TIMEOUT) throw Object.assign(new Error('NET_SDK_TransparentConfig took longer than 20000 ms'), { name: 'SdkTimeout' })
    return r
  }
  return REFUSE('unknown command')
}

const fakeNvr = (id, host, channels) => ({
  id,
  name: `NVR ${id}`,
  site: 'Test site',
  cfg: { host, port: 6036 },
  status: 'online',
  get online() {
    return this.status === 'online'
  },
  degraded: false,
  userId: 7,
  gen: 1,
  stopped: false,
  channels: channels.map(([ch, name]) => ({ ch, name, online: true }))
})
const n2 = fakeNvr('t2', '192.168.9.2', [[0, 'JP Wharf South'], [2, 'Maingate Roadway'], [3, 'Bond SE']])
const nx = fakeNvr('tx', '192.168.9.3', [[2, 'Maingate Roadway']]) // an NVR whose cameras have no line crossing
nodeLists.set(n2.id, fixture('nodelist.xml'))
nodeLists.set(nx.id, fixture('nodelist.xml').replace(/<supportTripwire>true<\/supportTripwire>/g, '<supportTripwire>false</supportTripwire>'))
let settingsNow = { alerts: { ntfy: { url: 'https://ntfy.sh', topic: '' } } }
const deps = { nvrs: new Map([[n2.id, n2], [nx.id, nx]]), transparent: fakeTransparent, getSettings: () => settingsNow }
const DEV = '192.168.9.2:6036'
const get = (nvr, ch) => handleLines('GET', nvr.id, ch, new URLSearchParams(), async () => ({}), 'tester', deps)
const post = (nvr, ch, body) => handleLines('POST', nvr.id, ch, new URLSearchParams(), async () => body, 'tester', deps)
/** Posts; if the answer asks for acknowledgements, acknowledges them all with its token and posts again. */
async function postAcked(nvr, ch, body) {
  const [st, b] = await post(nvr, ch, body)
  if (st !== 409 || !b.needsAck) return [st, b]
  return post(nvr, ch, { ...body, ack: b.needsAck.map((w) => w.key), ackToken: b.ackToken })
}
const addCam = (nvr, file) => {
  const cam = new Camera(fixture(file))
  cams.set(`${nvr.id}|${cam.chl.attrs.id.toUpperCase()}`, cam)
  return cam
}
const CLEAR = { direction: 'rightortop', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }
const ACROSS = { direction: 'rightortop', start: { x: 2000, y: 5000 }, end: { x: 8000, y: 5000 } }
const lines = (...set) => [0, 1, 2, 3].map((i) => set[i] ?? CLEAR)
const MAINGATE = '{00000003-0000-0000-0000-000000000000}'

// ---- GET ----------------------------------------------------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml') // IP619E5W: no person/vehicle filter
  const [st, b] = await get(n2, 2)
  const v = b.lines
  check('GET: the camera\'s settings, 4 slots, off', st === 200 && v?.supported === true && v.cfg.enabled === false && v.cfg.lines.length === 4 && v.cfg.chlId === MAINGATE, JSON.stringify(b).slice(0, 300))
  check('GET: the NVR\'s schedules, the device, a seen token, nothing to undo, no ntfy topic', v.schedules.map((s) => s.name).join() === '24x7,24x5,24x2' && v.device === DEV && typeof v.seen === 'string' && v.seen.length > 0 && v.undo === null && v.ntfy.topicSet === false)
  check('GET: only reads (queryNodeList, queryTripwire, queryScheduleList), nothing edited', ['queryNodeList', 'queryTripwire', 'queryScheduleList'].every((u) => sent.some((s) => s.url === u)) && sent.every((s) => s.url.startsWith('query')) && cam.edits.length === 0)
  check('GET: the read asks for this camera\'s param and trigger', sent.find((s) => s.url === 'queryTripwire').xml === `${XML_HEADER}<condition><chlId>${MAINGATE}</chlId></condition><requireField><param/><trigger/></requireField></request>`)
  check('GET: the support read is the web client\'s own request, with supportTripwire', /<nodeType type="nodeType">chls<\/nodeType>/.test(sent[0].xml) && /<supportTripwire\/>/.test(sent[0].xml) && sent[0].xml.startsWith(XML_HEADER))
  check('GET: every call carries the session it was made on', sent.every((s) => s.gen === 1))
  const n = sent.filter((s) => s.url === 'queryNodeList').length
  await get(n2, 2)
  check('support is cached per NVR: no second queryNodeList within 10 minutes', sent.filter((s) => s.url === 'queryNodeList').length === n)
  TIMING.supportMs = 0
  await get(n2, 2)
  check('... and asked again once the cache is older than TIMING.supportMs', sent.filter((s) => s.url === 'queryNodeList').length === n + 1)
  TIMING.supportMs = 10 * 60_000
  settingsNow = { alerts: { ntfy: { url: 'https://ntfy.sh', topic: 'argus-abcdefghij0123456789' } } }
  const [, b2] = await get(n2, 2)
  check('GET: ntfy.topicSet follows the settings', b2.lines.ntfy.topicSet === true)
  settingsNow = { alerts: { ntfy: { url: 'https://ntfy.sh', topic: '' } } }
  check('GET: a camera read as off is not in lines-on', !linesOn().has('t2/2'))
}

// ---- no line crossing on this camera --------------------------------------------------------------
{
  sent.length = 0
  addCam(nx, 'tripwire-ch3.xml')
  const [st, b] = await get(nx, 2)
  check('a camera the NVR says has no line crossing: supported false, its settings not read', st === 200 && b.lines.supported === false && b.lines.cfg === null && b.lines.seen === null && !sent.some((s) => s.url === 'queryTripwire'), JSON.stringify(b))
  const [st2, b2] = await post(nx, 2, { device: '192.168.9.3:6036', seen: 'x', change: { enabled: true }, confirm: true })
  check('... and a change to it is refused, nothing sent', st2 === 400 && /no line-crossing detection/.test(b2.error) && !sent.some((s) => s.url === 'editTripwire'), b2.error)
}

// ---- the route's own checks ----------------------------------------------------------------------
{
  const [s1] = await handleLines('GET', 'nope', 2, new URLSearchParams(), async () => ({}), 'tester', deps)
  const [s2] = await get(n2, 9)
  check('unknown NVR or camera: 404', s1 === 404 && s2 === 404)
  n2.status = 'offline'
  const [s3] = await get(n2, 2)
  n2.status = 'online'
  check('NVR offline: 409', s3 === 409)
  const [s4] = await handleLines('DELETE', n2.id, 2, new URLSearchParams(), async () => ({}), 'tester', deps)
  check('other methods: 405', s4 === 405)
  const [s5, b5] = await handleLines('POST', n2.id, 2, new URLSearchParams(), async () => null, 'tester', deps)
  check('a JSON null body: 400, not a crash', s5 === 400 && /JSON object/.test(b5.error))
  const [s6] = await post(n2, 2, { device: DEV, seen: 'x', change: { enabled: true } })
  check('without confirm: true -> 400', s6 === 400)
  const [s7] = await post(n2, 2, { device: '10.0.0.1:6036', seen: 'x', change: { enabled: true }, confirm: true })
  check('another device address -> 409', s7 === 409)
}

// ---- a line, acknowledged, logged first, read back, undone -----------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  const [, g] = await get(n2, 2)
  const seen = g.lines.seen
  const change = { enabled: true, lines: lines(ACROSS) }
  const [st, b] = await post(n2, 2, { device: DEV, seen: 'not-it', change, confirm: true })
  check('stale: seen from another state -> 409 stale, nothing sent', st === 409 && b.stale === true && cam.edits.length === 0, JSON.stringify(b))
  const [s1, b1] = await post(n2, 2, { device: DEV, seen, change, confirm: true })
  check('switching on a camera with no person/vehicle filter needs an acknowledgement: 409 needsAck + token, nothing sent', s1 === 409 && b1.needsAck?.map((w) => w.key).join() === 'no-filter' && typeof b1.needsAck[0].text === 'string' && typeof b1.ackToken === 'string' && cam.edits.length === 0, JSON.stringify(b1))
  check('nothing logged before the acknowledgement', !existsSync(LINES_LOG))
  const other = { enabled: true, lines: lines({ ...ACROSS, end: { x: 8000, y: 6000 } }) }
  const [s2, b2] = await post(n2, 2, { device: DEV, seen, change: other, ack: ['no-filter'], ackToken: b1.ackToken, confirm: true })
  check('the token is tied to the exact change: another line -> 409 again with a new token', s2 === 409 && b2.ackToken !== b1.ackToken && cam.edits.length === 0)
  const [s3] = await post(n2, 2, { device: DEV, seen, change, ack: [], ackToken: b1.ackToken, confirm: true })
  check('the token without the key -> 409', s3 === 409 && cam.edits.length === 0)
  const [s4, b4] = await post(n2, 2, { device: DEV, seen, change, ack: ['no-filter'], ackToken: b1.ackToken, confirm: true })
  const r = b4.result
  check('acknowledged: 200, one edit, read back, every changed field as asked, no side effects', s4 === 200 && cam.edits.length === 1 && r?.status === 'done' && r.message === 'Applied' && r.fields.length > 0 && r.fields.every((f) => f.status === 'as asked') && r.sideEffects.length === 0, JSON.stringify(b4).slice(0, 400))
  check('result: the acknowledged warnings', JSON.stringify(r.warningsAcked) === '["no-filter"]')
  check('result: the switch and line 1 are among the fields', ['enabled', 'line.0.start', 'line.0.end'].every((k) => r.fields.some((f) => f.key === k)), r.fields.map((f) => f.key).join())
  const body = cam.edits[0].xml
  check('the edit: the NVMS-9000 request for this camera and its schedule, switched on, the line, </request>', body.startsWith(`${XML_HEADER}<content><chl id="${MAINGATE}" scheduleGuid="{ED0F2AE8-6E54-4D89-BE10-E85445FAC8FB}">`) && body.endsWith('</request>') && body.includes('<switch>true</switch>') && body.includes('<startPoint><X>2000</X><Y>5000</Y></startPoint><endPoint><X>8000</X><Y>5000</Y></endPoint>'), body)
  check('the edit never carries the sound or white-light trigger', !/triggerAudio|triggerWhiteLight/.test(body))
  check('the camera now has it', cam.get('param.switch') === 'true')
  check('write-ahead: the change line was in the log before the edit went out, with the full before-state', cam.logAtEdit?.kind === 'change' && cam.logAtEdit.seq === r.seq && cam.logAtEdit.before?.enabled === false && cam.logAtEdit.before.lines.length === 4 && cam.logAtEdit.user === 'tester' && cam.logAtEdit.undo?.enabled === false)
  const log = logLines()
  check('the log: change then result, same seq, done, the acknowledgement kept', log.length === 2 && log[0].kind === 'change' && log[1].kind === 'result' && log[1].seq === r.seq && log[1].result === 'done' && log[0].ack.join() === 'no-filter' && log[0].ch === 3)
  check('the view is the camera as read back, with Undo for this change', b4.lines.cfg.enabled === true && b4.lines.undo?.seq === r.seq && b4.lines.undo.by === 'tester' && b4.lines.seen !== seen)
  check('lines-on: the camera is remembered, and saved', linesOn().has('t2/2') && savedOn()['t2/2'] === true)
  const [s5, b5] = await post(n2, 2, { device: DEV, undo: true, seq: 'not-it', confirm: true })
  check('undo with another seq -> 409, nothing sent', s5 === 409 && /Someone changed/.test(b5.error) && cam.edits.length === 1)
  const [s6, b6] = await postAcked(n2, 2, { device: DEV, undo: true, seq: r.seq, confirm: true })
  check('undo: off again, the slot cleared', s6 === 200 && b6.result?.status === 'done' && b6.result.message === 'Undone' && cam.get('param.switch') === 'false' && cam.edits.length === 2 && !cam.edits[1].xml.includes('<X>2000</X>'), JSON.stringify(b6.result ?? b6))
  check('undo: nothing more to undo, and lines-on forgets the camera', b6.lines.undo === null && !linesOn().has('t2/2') && !('t2/2' in savedOn()))
  const [s7] = await post(n2, 2, { device: DEV, undo: true, seq: r.seq, confirm: true })
  check('undo only once', s7 === 409 && cam.edits.length === 2)
  // someone draws the very same line again on the NVR's own page: that change was undone, and stays undone
  cam.set('param.switch', 'true')
  cam.set('param.line.item.startPoint.X', '2000')
  cam.set('param.line.item.startPoint.Y', '5000')
  cam.set('param.line.item.endPoint.X', '8000')
  cam.set('param.line.item.endPoint.Y', '5000')
  const [, g2] = await get(n2, 2)
  check('an undone change is never offered again, even when the camera shows what it left', g2.lines.cfg.enabled === true && g2.lines.undo === null)
}

// ---- Undo only while the camera shows what the change left ------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  const [, g] = await get(n2, 2)
  const [st, b] = await postAcked(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
  check('(set-up) applied', st === 200 && b.result?.status === 'done', JSON.stringify(b))
  cam.set('param.alarmHoldTime', '30') // someone changes it on the NVR's own page
  const [, g2] = await get(n2, 2)
  check('Undo is no longer offered once the camera differs from what the change left', g2.lines.undo === null)
  const [s2] = await post(n2, 2, { device: DEV, undo: true, seq: b.result.seq, confirm: true })
  check('... and refused if asked for anyway, nothing sent', s2 === 409 && cam.edits.length === 1)
}

// ---- an NVR relay output linked to line crossing: refuse rather than turn it on or leave it on (ruling) --
// checkChange (tripwire-xml.mjs) refuses whenever the resulting state is enabled with cfg.trigger.alarmOuts
// non-empty -- and apply() (tripwire.mjs) runs checkChange for both a change and an Undo, so this covers
// the Undo path too: an Undo is nothing but another change, restoring an older one.
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.node('trigger.alarmOut.alarmOuts').children.push({ name: 'item', attrs: { id: '{00000002-0000-0000-0000-000000000000}' }, children: [], text: 'Siren relay' })
  const [, g] = await get(n2, 2)
  const [s1, b1] = await post(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
  check('switching on a camera whose line crossing has an NVR relay linked: refused outright, nothing sent', s1 === 400 && /alarm output \(relay\)/.test(b1.error) && cam.edits.length === 0, b1.error)
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.set('param.switch', 'true') // the camera already has line crossing on (not this app's doing)
  cam.node('trigger.alarmOut.alarmOuts').children.push({ name: 'item', attrs: { id: '{00000001-0000-0000-0000-000000000000}' }, children: [], text: 'Gate relay' })
  const [, g] = await get(n2, 2)
  check('(set-up) already on, with an NVR relay linked to its line crossing', g.lines.cfg.enabled === true && g.lines.cfg.trigger.alarmOuts.length === 1, JSON.stringify(g.lines.cfg.trigger.alarmOuts))
  const [s1, b1] = await post(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: false }, confirm: true })
  check('(set-up) switching it off is not refused: turning it off can never fire the relay', s1 === 200 && b1.result?.status === 'done' && cam.edits.length === 1, JSON.stringify(b1))
  const before = logLines().length
  const [s2, b2] = await post(n2, 2, { device: DEV, undo: true, seq: b1.result.seq, confirm: true })
  check('Undo would switch it back on while the relay is still linked: refused just like a change, nothing sent or logged', s2 === 400 && /alarm output \(relay\)/.test(b2.error) && cam.edits.length === 1 && logLines().length === before, JSON.stringify(b2))
}

// ---- refusals and the other acknowledgements ---------------------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  const [, g] = await get(n2, 2)
  const seen = g.lines.seen
  const before = logLines().length
  const [s1, b1] = await post(n2, 2, { device: DEV, seen, change: { enabled: true, lines: lines({ ...ACROSS, end: { x: 2300, y: 5000 } }) }, confirm: true })
  check('refused: a line shorter than 5% of the picture; nothing sent or logged', s1 === 400 && /^Refused: .*Nothing was sent\.$/.test(b1.error) && cam.edits.length === 0 && logLines().length === before, b1.error)
  const [s2, b2] = await post(n2, 2, { device: DEV, seen, change: { holdTime: 7 }, confirm: true })
  check('refused: a hold time not among the camera\'s choices', s2 === 400 && cam.edits.length === 0, b2.error)
  sent.length = 0
  const [s3, b3] = await post(n2, 2, { device: DEV, seen, change: { scheduleGuid: '{00000000-1111-2222-3333-444444444444}' }, confirm: true })
  check('refused: a schedule the NVR does not have (its list read fresh for the check)', s3 === 400 && cam.edits.length === 0 && sent.some((s) => s.url === 'queryScheduleList'), b3.error)
  const [s4, b4] = await post(n2, 2, { device: DEV, seen, change: { colour: 'red' }, confirm: true })
  check('refused: a setting this route does not change', s4 === 400 && cam.edits.length === 0, b4.error)
  const [s5] = await post(n2, 2, { device: DEV, seen, change: 'on', confirm: true })
  check('change must be an object', s5 === 400)
  const [s6, b6] = await post(n2, 2, { device: DEV, seen, change: { enabled: true, holdTime: 5, lines: lines(ACROSS) }, confirm: true })
  check('a hold time under 10 s while on: the short-hold acknowledgement', s6 === 409 && b6.needsAck.map((w) => w.key).includes('short-hold') && cam.edits.length === 0, JSON.stringify(b6))
  const [s7, b7] = await post(n2, 2, { device: DEV, seen, change: { enabled: true }, confirm: true })
  check('switched on with no line set: the no-lines acknowledgement', s7 === 409 && b7.needsAck.map((w) => w.key).includes('no-lines') && cam.edits.length === 0, JSON.stringify(b7))
  const [s8, b8] = await post(n2, 2, { device: DEV, seen, change: { scheduleGuid: '{BD47C3AC-7BF3-4AAF-A84E-494855859247}' }, confirm: true })
  check('a schedule from the NVR\'s list: sent as chl@scheduleGuid, read back as asked', s8 === 200 && b8.result?.status === 'done' && cam.edits.at(-1)?.xml.includes('scheduleGuid="{BD47C3AC-7BF3-4AAF-A84E-494855859247}"') && cam.chl.attrs.scheduleGuid === '{BD47C3AC-7BF3-4AAF-A84E-494855859247}', JSON.stringify(b8.result ?? b8))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.set('param.mutexList.item.status', 'true') // intrusion (perimeter) is on
  const [, g] = await get(n2, 2)
  const [s1, b1] = await post(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
  check('switching on while a detection that cannot run beside it is on: the mutex acknowledgement', s1 === 409 && b1.needsAck.map((w) => w.key).includes('mutex') && cam.edits.length === 0, JSON.stringify(b1))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.set('param.triggerWhiteLight', 'true') // someone set it on the NVR
  const [, g] = await get(n2, 2)
  const [s1, b1] = await postAcked(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
  check('the camera\'s white-light trigger is on: the change is refused, nothing sent (floodlight by hand only)', s1 === 400 && /hand only/.test(b1.error) && cam.edits.length === 0, b1.error)
}

// ---- what the camera did with it ------------------------------------------------------------------
const enableAcross = async () => {
  const [, g] = await get(n2, 2)
  return postAcked(n2, 2, { device: DEV, seen: g.lines.seen, change: { enabled: true, lines: lines(ACROSS) }, confirm: true })
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ ignore: true }) // the NVR says yes, the camera keeps its settings
  const [st, b] = await enableAcross()
  check('accepted but not applied: every field "not applied", failed, said so', st === 200 && b.result.status === 'failed' && b.result.fields.every((f) => f.status === 'not applied') && /kept its line settings/.test(b.result.message), JSON.stringify(b.result))
  check('... read back three times (1.5, 3, 6 s; shortened here), never sent again', cam.edits.length === 1 && cam.reads - cam.readsAtEdit === 3, `${cam.reads - cam.readsAtEdit} reads`)
  check('... nothing to undo, and lines-on stays off', b.lines.undo === null && !linesOn().has('t2/2'))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => REFUSE('536870947')
  const [st, b] = await enableAcross()
  check('refused by the NVR: failed with its error code, read back once', st === 200 && b.result.status === 'failed' && /refused \(536870947\)/.test(b.result.message) && cam.reads - cam.readsAtEdit === 1, JSON.stringify(b.result))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ then: (c) => c.set('trigger.msgPushSwitch', 'false') })
  const [st, b] = await enableAcross()
  const fx = b.result?.sideEffects?.find((s) => s.key === 'trigger.msgPush')
  check('a side effect found by the full read-back: push messages on -> off, reported', st === 200 && b.result.status === 'done' && fx?.from === 'true' && fx?.to === 'false' && /The camera also changed: trigger\.msgPush true → false/.test(b.result.message), JSON.stringify(b.result))
  check('... and in the result line of the log', logLines().at(-1).sideEffects?.some((s) => s.key === 'trigger.msgPush'))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ delay: 2 })
  const [st, b] = await enableAcross()
  check('late: shows on the second read-back -> done, no third read', st === 200 && b.result.status === 'done' && cam.reads - cam.readsAtEdit === 2, `${b.result?.status} after ${cam.reads - cam.readsAtEdit} reads`)
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ timeout: true, delay: 2 }) // the SDK gives up waiting; the camera applies it a little later
  const [st, b] = await enableAcross()
  check('no answer in time, applied later: read back until it shows -> done', st === 200 && b.result.status === 'done' && b.result.answer === 'no answer in time' && cam.reads - cam.readsAtEdit === 2, JSON.stringify(b.result))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  cam.onEdit = () => ({ ignore: true, then: (c) => (c.offline = true) }) // gone right after the edit
  const [st, b] = await enableAcross()
  check('no read-back at all: unknown, said so, nothing to undo', st === 200 && b.result.status === 'unknown' && /could not be read back/.test(b.result.message) && b.lines.undo === null && logLines().at(-1).result === 'unknown', JSON.stringify(b.result))
}

// ---- answers that must not be acted on ----------------------------------------------------------------
{
  cams.set(`${n2.id}|{00000004-0000-0000-0000-000000000000}`, new Camera(fixture('tripwire-ch3.xml'))) // Bond SE answered with Maingate's settings
  const [st, b] = await get(n2, 3)
  check('an answer for another camera: 502, never shown or used', st === 502 && /another camera/.test(b.error), JSON.stringify(b))
}
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  const [, g] = await get(n2, 2)
  const logged = logLines().length
  degradeOnRead = n2 // the NVR goes into recovery right after the fresh read
  const [st, b] = await post(n2, 2, { device: DEV, seen: g.lines.seen, change: { scheduleGuid: '{BD47C3AC-7BF3-4AAF-A84E-494855859247}' }, confirm: true })
  degradeOnRead = null
  n2.degraded = false
  check('the NVR busy or reconnected after the fresh read: 409, nothing sent or logged', st === 409 && /nothing was sent/.test(b.error) && cam.edits.length === 0 && logLines().length === logged, JSON.stringify(b))
}

// ---- one change per NVR ---------------------------------------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch3.xml')
  let release
  hold = new Promise((r) => (release = r))
  const inside = new Promise((r) => (arrived = r))
  const first = enableAcross()
  await inside
  const [s2, b2] = await post(n2, 3, { device: DEV, seen: 'x', change: { enabled: true }, confirm: true })
  check('a second change on the same NVR while one is inside it -> 409, says what is running', s2 === 409 && /A line-crossing change is running on this NVR/.test(b2.error), b2.error)
  release()
  hold = null
  arrived = () => {}
  const [s1, b1] = await first
  check('... and the first one finishes', s1 === 200 && b1.result.status === 'done' && cam.edits.length === 1)
}

// ---- a camera with the person/vehicle filter (IP6196W) -----------------------------------------------
{
  const cam = addCam(n2, 'tripwire-ch1.xml')
  const [, g] = await get(n2, 0)
  check('IP6196W: the car/person/motor filter as the camera reports it', g.lines.cfg.filter?.kind === 'objects' && ['car', 'person', 'motor'].every((c) => g.lines.cfg.filter.classes[c]?.on === true), JSON.stringify(g.lines.cfg.filter))
  const [st, b] = await postAcked(n2, 0, { device: DEV, seen: g.lines.seen, change: { filter: { car: { on: false, sensitivity: 50 }, person: { on: true, sensitivity: 70 } } }, confirm: true })
  check('a filter change: sent, read back as asked', st === 200 && b.result?.status === 'done' && cam.get('param.objectFilter.car.switch') === 'false' && cam.get('param.objectFilter.person.sensitivity') === '70', JSON.stringify(b.result ?? b))
  check('... the size boxes echoed as read', cam.edits[0].xml.includes('<minDetectTarget><width>100</width><height>100</height></minDetectTarget>'))
  const [, other] = await get(n2, 2)
  check('Undo is per camera: this change is not offered on Maingate Roadway', b.lines.undo?.seq === b.result.seq && other.lines.undo?.seq !== b.result.seq)
}

// ---- server.mjs wiring (it loads the SDK, so it is read as text) ----------------------------------------
{
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  check('server.mjs imports handleLines', /import \{ handleLines \} from '\.\/tripwire\.mjs'/.test(src))
  check('server.mjs: /lines is a camera route taking GET and POST', src.includes("lines: ['GET', 'POST']") && src.includes('|stream\\/estimate|notes|figures|lines)$/'))
  const at = src.indexOf('await handleLines(req.method, id, ch, url.searchParams, readJson, user)')
  check('server.mjs dispatches it inside the admin block (admins only, same-origin JSON)', at > 0 && at > src.indexOf("if (pathname.startsWith('/api/admin/'))"))
}

check('every command sent in this whole test was a query or editTripwire', [...urls].every((u) => /^query/.test(u) || u === 'editTripwire'), [...urls].join())

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
