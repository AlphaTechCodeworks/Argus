// Offline tests for nvr-disks.mjs: nothing is sent anywhere and the native SDK is never loaded,
// so this runs on a Windows development PC as well as on the server.
//   node cctv/test/nvr-disks.test.mjs
//
// The fixtures in test/fixtures/disks-nvr are written by hand in the shape the SDK library's own
// strings say these commands return (diskList / diskStatus / freeSpace / totalSpace, and
// slotIndex / recStartDate / recEndDate). Until the discovery run against a real NVR confirms
// them they are an informed guess, which is exactly why the parsers are forgiving and why an
// unrecognised answer has to end as "not available" rather than as a wrong-but-confident number.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRESH_MS, STALE_OK_MS, carrySmart, diskState, makeNvrStorage, parseDate, parseDiskStatus, parseStorageDevInfo, parseSmart, parseSystemCaps, readStorage, sizeBytes, smartRequest } from '../nvr-disks.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const dir = join(import.meta.dirname, 'fixtures', 'disks-nvr')
const fixture = (name) => readFileSync(join(dir, `${name}.xml`), 'utf8')
const DISKS = fixture('queryDiskStatus')
const RECORD = fixture('queryStorageDevInfo')
const CAPS = fixture('querySystemCaps')
const REFUSED = fixture('notSupported')

// ---- parsing a real-shaped answer --------------------------------------------------------------
{
  const r = parseDiskStatus(DISKS)
  check('the disk list parses', r.ok && r.disks.length === 2, JSON.stringify(r).slice(0, 120))
  check('a working disk is ok', r.disks[0].state === 'ok' && r.disks[0].status === 'read/write', JSON.stringify(r.disks[0]))
  check('a disk the NVR calls "exception" is bad', r.disks[1].state === 'bad', r.disks[1].state)
  check('sizes come back in bytes (MB in the answer)', r.disks[0].totalBytes === 3_815_447_000_000 && r.disks[0].freeBytes === 41_120_000_000, `${r.disks[0].totalBytes}/${r.disks[0].freeBytes}`)
  check('the model and serial are carried through', r.disks[0].model === 'ST4000VX016-3CV104' && r.disks[0].serial === 'ZGY1A2B3')
}
{
  const r = parseStorageDevInfo(RECORD)
  check('the recording dates parse', r.ok && r.slots.length === 2, JSON.stringify(r).slice(0, 120))
  check('days are inclusive of both ends', r.slots[0].days === 33 && r.slots[1].days === 7, `${r.slots[0].days}/${r.slots[1].days}`)
}
{
  const r = parseSystemCaps(CAPS)
  check('firmware and the camera limit parse', r.ok && r.caps.firmware === '1.4.5.2-B0012.0' && r.caps.maxCameras === 32, JSON.stringify(r.caps))
  check('the NVR\'s own spelling of "kenerlVersion" is handled', r.caps.kernel === '4.9.84', r.caps.kernel)
}

// ---- classification ----------------------------------------------------------------------------
check('read/write, in any spelling, is healthy', ['read/write', 'readwrite', 'read write', 'normal', 'OK'].every((s) => diskState(s) === 'ok'))
check('the broken words are broken', ['exception', 'unformat', 'disk error', 'SMART failed', 'no disk'].every((s) => diskState(s) === 'bad'))
check('formatting is busy, not broken', diskState('formatting') === 'busy')
check('read only is a warning', diskState('read only') === 'warn')
// A word we have never seen must not be reported as healthy, and must not page the owner either.
check('an unknown word is unknown, not ok and not bad', diskState('quantum flux') === 'unknown' && diskState('') === 'unknown')
check('sizes: a missing figure stays null, never 0', sizeBytes(null) === null && sizeBytes('') === null && sizeBytes(undefined) === null)
check('dates: the shapes these answers use', parseDate('2026-09-25') === Date.UTC(2026, 8, 25) && parseDate('2026/9/5') === Date.UTC(2026, 8, 5) && parseDate('20260925') === Date.UTC(2026, 8, 25))
check('dates: nonsense is null', parseDate('') === null && parseDate('not a date') === null && parseDate('2026-13-01') === null)

// ---- one NVR's merged answer -------------------------------------------------------------------

const nvr = { id: 'nvr1', name: 'Main site', online: true }
const answers = (map) => async (_nvr, url) => {
  if (!(url in map)) throw new Error(`the NVR did not accept the request (error 536870983)`)
  return map[url]
}
const ALL = { queryDiskStatus: DISKS, queryStorageDevInfo: RECORD, querySystemCaps: CAPS }
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0)
const at = (t) => () => t

{
  const s = await readStorage(nvr, answers(ALL), at(T0))
  check('a full answer is available', s.available === true, s.why)
  check('the two views are merged by slot', s.disks.length === 2 && s.disks[0].days === 33 && s.disks[1].days === 7, JSON.stringify(s.disks.map((d) => d.days)))
  // With two disks recording in parallel, "30 days" is only true while BOTH go back that far.
  check('the NVR holds what its shortest disk holds', s.days === 7, String(s.days))
  check('the worst disk sets the verdict', s.worst === 'bad', s.worst)
  check('firmware rides along', s.caps.firmware === '1.4.5.2-B0012.0')
}

// ---- an NVR that does not support the query ----------------------------------------------------
{
  const s = await readStorage(nvr, answers({}), at(T0))
  check('nothing answered: not available, with a reason', s.available === false && /queryDiskStatus/.test(s.why), s.why)
  check('and no invented readings', s.disks.length === 0 && s.days === null && s.worst === 'unknown')
}
{
  // Answers, but refuses: status "fail" with an errorCode, which is what older firmware sends.
  const s = await readStorage(nvr, answers({ queryDiskStatus: REFUSED, queryStorageDevInfo: REFUSED, querySystemCaps: REFUSED }), at(T0))
  check('a refusal is not available either', s.available === false && /536870983/.test(s.why), s.why)
}
{
  // Only the dates: still worth reporting the retention rather than showing nothing.
  const s = await readStorage(nvr, answers({ queryStorageDevInfo: RECORD }), at(T0))
  check('dates without a disk list still give the days', s.available === true && s.days === 7 && s.disks.length === 2, JSON.stringify(s).slice(0, 140))
  check('but the disk condition stays unknown, not ok', s.disks.every((d) => d.state === 'unknown'), s.worst)
}
{
  const s = await readStorage({ ...nvr, online: false, status: 'offline', error: 'connection refused' }, answers(ALL), at(T0), async () => ({ ok: false, why: 'did not answer a connection to 10.0.0.9:6036 within 2000 ms' }))
  check('an offline NVR is not asked, and says why', s.available === false && /did not answer a connection/.test(s.why), s.why)
  check('and the probe\'s verdict is carried', s.reachable === false)
}
{
  const s = await readStorage({ ...nvr, online: false, status: 'offline', error: 'password wrong' }, answers(ALL), at(T0), async () => ({ ok: true, why: '' }))
  check('reachable but not logged in reads differently', /answers on the network/.test(s.why) && s.reachable === true, s.why)
}
{
  // readStorage must never throw, whatever the query does.
  const s = await readStorage(nvr, async () => { throw new Error('boom') }, at(T0))
  check('a query that blows up is a reason, not a crash', s.available === false && /boom/.test(s.why), s.why)
  const bad = await readStorage(nvr, async () => 'this is not xml at all <<<', at(T0))
  check('a nonsense answer is a reason, not a crash', bad.available === false, bad.why)
}

// ---- the cache -----------------------------------------------------------------------------
{
  let now = T0
  let calls = 0
  const store = makeNvrStorage({
    listNvrs: () => [nvr],
    query: async (_n, url) => { calls++; return ALL[url] ?? (() => { throw new Error('no') })() },
    now: () => now,
    freshMs: 10 * 60_000,
    retryMs: 2 * 60_000
  })
  check('nothing is known before the first read', store.get('nvr1') === null)
  await store.refresh()
  check('after one round the answer is there', store.get('nvr1')?.available === true)
  const first = calls
  await store.refresh()
  check('a second round inside the freshness window asks nothing', calls === first, `${calls} vs ${first}`)
  now = T0 + 9 * 60_000
  await store.refresh()
  check('still nothing at 9 minutes', calls === first)
  now = T0 + 10 * 60_000
  await store.refresh()
  check('at 10 minutes it asks again', calls > first, `${calls} vs ${first}`)
}
{
  // A failure is retried sooner than a success is refreshed, so a passing fault heals by itself.
  let now = T0
  let calls = 0
  const store = makeNvrStorage({
    listNvrs: () => [nvr],
    query: async () => { calls++; throw new Error('nope') },
    now: () => now,
    freshMs: 10 * 60_000,
    retryMs: 2 * 60_000
  })
  await store.refresh()
  check('a failure is remembered as not available', store.get('nvr1')?.available === false)
  const after = calls
  now = T0 + 60_000
  await store.refresh()
  check('not retried after a minute', calls === after)
  now = T0 + 2 * 60_000
  await store.refresh()
  check('retried after two minutes', calls > after)
}
{
  // An NVR list that blows up must not take the check loop with it.
  const store = makeNvrStorage({ listNvrs: () => { throw new Error('gone') }, query: async () => DISKS, log: () => {} })
  await store.refresh()
  check('a broken NVR list is survivable', store.get('nvr1') === null)
}
{
  // Two rounds overlapping must not send the same query twice.
  let now = T0
  let started = 0
  let release
  const gate = new Promise((r) => (release = r))
  const store = makeNvrStorage({ listNvrs: () => [nvr], query: async (_n, url) => { started++; await gate; return ALL[url] ?? '' }, now: () => now })
  const a = store.refresh()
  const b = store.refresh()
  release()
  await Promise.all([a, b])
  // Counted against one round rather than a fixed number: the number of queries a round makes
  // grows with the disks (each one is asked for its SMART data), and what matters here is that
  // the second round added nothing, not how many the first one took.
  let solo = 0
  const one = makeNvrStorage({ listNvrs: () => [nvr], query: async (_n, url) => { solo++; return ALL[url] ?? '' }, now: () => now })
  await one.refresh()
  check('overlapping rounds ask the NVR once', started === solo, `${started} queries against ${solo} for a single round`)
}

// ---- the shape the real NVRs actually answer with, 2026-09-25 -------------------------------------
//
// No longer a guess: this is nvr-2's own answer, copied verbatim from a discovery run. Two things
// about it defeated the old reader, and between them they blanked every field on the Health page.
//
//   - queryDiskStatus puts its items straight under <content type="list">, with no <diskList>
//     around them, so a reader looking only for the named lists found no disks at all.
//   - it names its disks only by GUID and carries no slotIndex, while queryStorageDevInfo carries
//     both -- so pairing the two answers by slot left every disk's condition stranded.
{
  const DS = `<?xml version="1.0" encoding="UTF-8"?><response version="1.0" cmdUrl="queryDiskStatus"><status>success</status><types><diskStatus><enum>read/write</enum><enum>read</enum><enum>bad</enum></diskStatus></types><content type="list"><itemType type="diskStatus"></itemType><item id="{C131C5D2-0842-46E9-B3BE-549E60AD184E}"><diskStatus>read/write</diskStatus><diskEncryptStatus>notEncrypted</diskEncryptStatus></item></content></response>`
  const SDI = `<?xml version="1.0" encoding="UTF-8"?><response version="1.0" cmdUrl="queryStorageDevInfo"><status>success</status><content><cycleRecord>true</cycleRecord><storageSysInfo><supportedRaidType type="list"><item>RAID_TYPE_0</item><item>RAID_TYPE_1</item></supportedRaidType></storageSysInfo><raidCardList type="list"></raidCardList><raidList type="list"><itemType><realSize unit="MB"></realSize></itemType></raidList><diskList type="list"><itemType><size unit="MB"></size></itemType><item id="{C131C5D2-0842-46E9-B3BE-549E60AD184E}"><raidId>{00000000-0000-0000-0000-000000000000}</raidId><slotIndex>1</slotIndex><diskInterfaceType>sata</diskInterfaceType><serialNum>ZV70E99C</serialNum><model>ST12000VE001-3BN101 </model><size>11444224</size><freeSpace>0</freeSpace><recStartDate>2026-09-10</recStartDate><recEndDate>2026-09-25</recEndDate></item></diskList></content></response>`
  const CAPS = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="querySystemCaps"><status>success</status><content><chlMaxCount>32</chlMaxCount><ipChlMaxCount>32</ipChlMaxCount><playbackMaxWin>16</playbackMaxWin><totalBandwidth unit="Mb">192</totalBandwidth><usedTotalBandwidth unit="Kb">131072</usedTotalBandwidth><supportHDHealth>true</supportHDHealth></content></response>`
  const q = async (n, url) => (url === 'queryDiskStatus' ? DS : url === 'queryStorageDevInfo' ? SDI : CAPS)
  const r = await readStorage({ id: 'nvr-2', name: 'NVR 2', online: true }, q, () => 0)
  const d = r.disks[0]
  check('one disk, not none', r.available === true && r.disks.length === 1, JSON.stringify(r.disks))
  check('items straight under <content> are found', d.status === 'read/write' && d.state === 'ok', `${d.status} ${d.state}`)
  check('the two answers pair up by GUID when there is no slot to pair on', d.slot === 1 && d.serial === 'ZV70E99C', JSON.stringify(d))
  check('the model comes through', d.model === 'ST12000VE001-3BN101', String(d.model))
  // 11444224 MB is a 12 TB drive. A thousandfold slip here reads as 11 GB and looks like a fault.
  check('the size is read in the megabytes the list declares', d.totalBytes === 11444224e6, String(d.totalBytes))
  check('a full cycling disk is zero free, not unknown', d.freeBytes === 0, String(d.freeBytes))
  check('the recording days come through', d.days === 16, String(d.days))
  // the raid type lists in this same answer also hold <item> elements, and are not disks
  check('the raid type lists are not mistaken for disks', r.disks.length === 1)
  check('the camera limit is read', r.caps.maxCameras === 32 && r.caps.maxPlaybackWindows === 16)
  check('the bandwidth figures are read', r.caps.totalBandwidthMbps === 192 && r.caps.usedBandwidthKbps === 131072, JSON.stringify(r.caps))
}

// ---- SMART ----------------------------------------------------------------------------------------
//
// nvr-2's own reply, 2026-09-25. The command name was found by elimination (every wrong name gives
// a bare HTTP 404; this one gave XML), and it refuses any request that does not name a disk.
{
  const attr = (id, v, raw, st = 'normal', kind = 'Oldage') =>
    `<item id="${id}"><value>${v}</value><worstValue>${v}</worstValue><threshold>0</threshold><rawValue>${raw}</rawValue><type>${kind}</type><state>0</state><smartStatus>${st}</smartStatus></item>`
  const reply = (items, extra = '') =>
    `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryDiskSmartInfo"><status>success</status><content><id>{D1}</id><smartItems type="list"><itemType><smartStatus type="smartStatus"></smartStatus></itemType>${items}</smartItems><temperature>30</temperature><powerOnDays>463</powerOnDays><diskStatus type="diskStatus">${extra || 'good'}</diskStatus></content></response>`

  // The real attribute values off nvr-2's drive.
  const healthy = attr(1, 100, 1352435, 'normal', 'Pre-fail') + attr(5, 100, 0, 'normal', 'Pre-fail') +
    attr(7, 89, 889728777, 'normal', 'Pre-fail') + attr(9, 88, 11090) + attr(187, 100, 0) +
    attr(188, 100, 0) + attr(194, 30, 30) + attr(197, 100, 0) + attr(198, 100, 0)

  const r = parseSmart(reply(healthy))
  check('the drive is read as good', r.ok && r.smart.verdict === 'good' && r.smart.state === 'ok', JSON.stringify(r.smart?.state))
  check('the temperature is read', r.smart.temperature === 30)
  check('how long it has been powered on is read', r.smart.powerOnDays === 463)
  check('the attributes are named, not left as numbers', r.smart.attrs.find((a) => a.id === 197)?.name === 'Pending sectors')
  // The trap this must not fall into: Seagate encodes attributes 1 and 7 so that a perfectly
  // healthy drive reports raw values in the hundreds of millions. Calling a big number a bad
  // number would condemn every healthy Seagate in the estate.
  check('889 million Seagate seek errors are not a fault', r.smart.concerns.length === 0, JSON.stringify(r.smart.concerns))

  // The five that actually predict failure, one at a time.
  for (const [id, what] of [[5, 'reallocated sectors'], [187, 'reported uncorrectable'], [188, 'command timeouts'], [197, 'pending sectors'], [198, 'offline uncorrectable']]) {
    // attribute 5 is Pre-fail on this drive and the rest are Oldage, so the line to swap out is
    // whichever one the fixture actually holds
    const kind = id === 5 ? 'Pre-fail' : 'Oldage'
    const was = attr(id, 100, 0, 'normal', kind)
    if (!healthy.includes(was)) { check(`fixture holds attribute ${id}`, false, 'test bug'); continue }
    const bad = parseSmart(reply(healthy.replace(was, attr(id, 90, 4, 'normal', kind))))
    check(`a non-zero count of ${what} is a concern`, bad.smart.concerns.length === 1 && bad.smart.state === 'warn', JSON.stringify(bad.smart.concerns))
  }
  // A drive can be writable and still failing: the NVR says read/write, the drive says otherwise.
  check('the drive\'s own poor verdict is believed', parseSmart(reply(healthy, 'lowHealth')).smart.state === 'warn')
  check('and a bad one more so', parseSmart(reply(healthy, 'bad')).smart.state === 'bad')
  check('a word we do not know is unknown, not a guess', parseSmart(reply(healthy, 'somethingNew')).smart.state === 'unknown')
  // An overheating drive is a fault whatever its attributes say.
  check('a drive being cooked is a concern', parseSmart(reply(healthy).replace('<temperature>30<', '<temperature>58<')).smart.concerns.some((c) => c.includes('58')))
  check('and a cool one is not', !parseSmart(reply(healthy)).smart.concerns.some((c) => c.includes('°C')))
  // The drive flagging an attribute itself is trusted even where we would not have judged it.
  check('an attribute the drive itself flags is a concern', parseSmart(reply(healthy.replace(attr(9, 88, 11090), attr(9, 88, 11090, 'warn')))).smart.concerns.length === 1)

  const refused = parseSmart('<?xml version="1.0"?><response cmdUrl="queryDiskSmartInfo"><status>fail</status><errorCode>536870923</errorCode></response>')
  check('a refusal is a refusal, not an empty healthy report', refused.ok === false && refused.smart === null && refused.errorCode === '536870923')
  check('the request names the disk, which is what it refuses without', smartRequest('{D1}').includes('<condition><diskId>{D1}</diskId></condition>'))
}
{
  // A SMART reply we cannot make sense of must never make a working disk look worse.
  const ID = '{D9}'
  const DS = `<?xml version="1.0"?><response cmdUrl="queryDiskStatus"><status>success</status><content type="list"><item id="${ID}"><diskStatus>read/write</diskStatus></item></content></response>`
  const SDI = `<?xml version="1.0"?><response cmdUrl="queryStorageDevInfo"><status>success</status><content><diskList type="list"><itemType><size unit="MB"></size></itemType><item id="${ID}"><slotIndex>1</slotIndex><size>11444224</size><freeSpace>0</freeSpace><recStartDate>2026-09-10</recStartDate><recEndDate>2026-09-25</recEndDate></item></diskList></content></response>`
  const NONSENSE = '<?xml version="1.0"?><response cmdUrl="queryDiskSmartInfo"><status>success</status><content><somethingElse>1</somethingElse></content></response>'
  const q = async (_n, url) => (url === 'queryDiskStatus' ? DS : url === 'queryStorageDevInfo' ? SDI : url === 'queryDiskSmartInfo' ? NONSENSE : '<?xml version="1.0"?><response><status>success</status><content></content></response>')
  const r = await readStorage({ id: 'x', name: 'X', online: true }, q, () => 0)
  check('an unreadable SMART reply does not downgrade a disk that is recording', r.disks[0].state === 'ok' && r.worst === 'ok', `${r.disks[0].state} / ${r.worst}`)
}

// ---- SMART carried forward, and the last good snapshot kept while fresh reads fail over P2P --------
// The bug this fixes: the per-disk queryDiskSmartInfo times out over the cloud often enough that a
// disk read which otherwise worked would keep losing its SMART, and sometimes the whole read timed
// out and blanked the panel -- "sometimes I'm not seeing the SMART results".
{
  const ID = '{DS1}'
  const DS = `<?xml version="1.0"?><response cmdUrl="queryDiskStatus"><status>success</status><content type="list"><item id="${ID}"><diskStatus>read/write</diskStatus></item></content></response>`
  const SDI = `<?xml version="1.0"?><response cmdUrl="queryStorageDevInfo"><status>success</status><content><diskList type="list"><itemType><size unit="MB"></size></itemType><item id="${ID}"><slotIndex>1</slotIndex><size>11444224</size><freeSpace>0</freeSpace><recStartDate>2026-09-10</recStartDate><recEndDate>2026-09-25</recEndDate></item></diskList></content></response>`
  const SMART_OK = `<?xml version="1.0"?><response cmdUrl="queryDiskSmartInfo"><status>success</status><content><id>${ID}</id><diskStatus>good</diskStatus><temperature>30</temperature><powerOnDays>400</powerOnDays><smartItems type="list"><item id="194"><value>65</value><worstValue>60</worstValue><threshold>0</threshold><rawValue>30</rawValue><type>Oldage</type><smartStatus>normal</smartStatus></item></smartItems></content></response>`
  const SMART_FAIL = '<?xml version="1.0"?><response cmdUrl="queryDiskSmartInfo"><status>fail</status><errorCode>536870923</errorCode></response>'
  const EMPTY = '<?xml version="1.0"?><response><status>success</status><content></content></response>'
  const ALL_FAIL = '<?xml version="1.0"?><response><status>fail</status><errorCode>1</errorCode></response>'
  let smartXml = SMART_OK
  let allFail = false
  let now = T0
  const q = async (_n, url) => {
    if (allFail) return ALL_FAIL
    if (url === 'queryDiskStatus') return DS
    if (url === 'queryStorageDevInfo') return SDI
    if (url === 'queryDiskSmartInfo') return smartXml
    return EMPTY
  }
  const store = makeNvrStorage({ listNvrs: () => [nvr], query: q, now: () => now, log: () => {} })

  await store.refresh()
  const first = store.get('nvr1')
  check('SMART is read on a good read', first?.disks?.[0]?.smart != null && first.disks[0].smartAt === first.at)
  const smartAt0 = first.disks[0].smartAt

  smartXml = SMART_FAIL // the disk list is still fine, only queryDiskSmartInfo fails now
  now = T0 + FRESH_MS + 1
  await store.refresh()
  const second = store.get('nvr1')
  check('SMART is carried forward when its query fails', second?.available === true && second.disks[0].smart != null)
  check('  it keeps the time it was actually read, not now', second.disks[0].smartAt === smartAt0)
  check('  the read itself is not marked stale (the disk list was fresh)', !second.stale)

  allFail = true // now the whole read fails
  now = T0 + 2 * FRESH_MS + 2
  await store.refresh()
  const third = store.get('nvr1')
  check('a failed read falls back to the last good, marked stale', third?.available === true && third.stale === true && third.disks[0].smart != null)

  now = T0 + FRESH_MS + STALE_OK_MS + 2 // older than staleOkMs past the last good read
  check('beyond staleOkMs the stale snapshot is dropped', store.get('nvr1')?.available !== true)
}

// carrySmart on its own: fills only the gaps, dates what it carries, and lowers a state but never raises it
{
  const prev = { available: true, at: 1000, disks: [{ id: 'A', state: 'ok', smart: { state: 'warn' } }, { id: 'B', state: 'ok', smart: { state: 'ok' } }] }
  const fresh = { available: true, at: 5000, disks: [{ id: 'A', state: 'ok' /* smart lost */ }, { id: 'B', state: 'ok', smart: { state: 'ok' } }] }
  const out = carrySmart(prev, fresh)
  check('carrySmart: a disk that lost its SMART gets the last one', out.disks[0].smart?.state === 'warn' && out.disks[0].smartAt === 1000)
  check('carrySmart: a disk with fresh SMART is dated now and left alone', out.disks[1].smartAt === 5000)
  check('carrySmart: a carried warn lowers the disk state', out.disks[0].state === 'warn')
  check('carrySmart: an unavailable fresh read is returned untouched', carrySmart(prev, { available: false }).available === false)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
