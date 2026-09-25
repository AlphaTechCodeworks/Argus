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
import { diskState, makeNvrStorage, parseDate, parseDiskStatus, parseStorageDevInfo, parseSystemCaps, readStorage, sizeBytes } from '../nvr-disks.mjs'

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
  check('overlapping rounds ask the NVR once', started === 3, `${started} queries for 3 commands`)
}

// ---- the shape the real NVRs actually answer with, 2026-09-25 -------------------------------------
//
// No longer a guess. These NVMS-9000 boxes refuse queryDiskStatus outright and put the model,
// serial, size and free space in queryStorageDevInfo alongside the recording dates -- the opposite
// of what the SDK's own strings suggested. Reading only the dates out of that answer is what made
// the Health page show a disk it could name with every other field blank.
{
  const SDI = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryStorageDevInfo"><status>success</status><content><diskList type="list"><itemType><size unit="MB"></size><freeSpace unit="MB"></freeSpace></itemType><item id="{d1}"><raidId></raidId><slotIndex>1</slotIndex><diskInterfaceType>sata</diskInterfaceType><serialNum>ZRT0CMKL</serialNum><model>ST12000VE001-3BN101 </model><size>11444224</size><freeSpace>0</freeSpace><recStartDate>2026-09-08</recStartDate><recEndDate>2026-09-25</recEndDate></item></diskList></content></response>`
  const REFUSED = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="queryDiskStatus"><status>fail</status><errorCode>536870913</errorCode></response>`
  const CAPS = `<?xml version="1.0" encoding="UTF-8"?><response cmdUrl="querySystemCaps"><status>success</status><content><ipChlMaxCount>32</ipChlMaxCount><playbackMaxWin>16</playbackMaxWin></content></response>`
  const q = async (n, url) => (url === 'queryDiskStatus' ? REFUSED : url === 'queryStorageDevInfo' ? SDI : CAPS)
  const r = await readStorage({ id: 'nvr1', name: 'NVR 1', online: true }, q, () => 0)
  const d = r.disks[0]
  check('the disk survives queryDiskStatus being refused', r.available === true && r.disks.length === 1)
  check('the model comes through', d.model === 'ST12000VE001-3BN101', String(d.model))
  check('the serial comes through', d.serial === 'ZRT0CMKL', String(d.serial))
  check('the id comes through', d.id === '{d1}', String(d.id))
  // 11444224 MB is a 12 TB drive. A thousandfold slip here reads as 11 GB and looks like a fault.
  check('the size is read in the megabytes the list declares', d.totalBytes === 11444224e6, String(d.totalBytes))
  check('a full cycling disk is zero free, not unknown', d.freeBytes === 0, String(d.freeBytes))
  check('the recording days still come through', d.days === 18, String(d.days))
  check('a condition the NVR would not give stays unknown rather than invented', d.state === 'unknown' && d.status === null)
  check('the camera limit is read', r.caps.maxCameras === 32 && r.caps.maxPlaybackWindows === 16)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
